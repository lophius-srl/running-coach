import { describe, expect, it } from "vitest";
import { decodeFitSummary, inspectFit, type FitSummary } from "./fit";
import {
  encodeFit,
  fitTime,
  type FitFieldSpec,
  type FitMessageSpec,
  wrapFitData,
} from "./fit-test-encoder";
import suuntoRunDataUrl from "./fixtures/fit/suunto-run-anonymized.fit?inline";

const START = "2026-11-03T07:30:00Z";

const fileId = (manufacturer: number | null = 23): FitMessageSpec => ({
  global: 0,
  fields: [
    { num: 0, type: "enum", value: 4 }, // type = activity
    { num: 1, type: "uint16", value: manufacturer },
    { num: 2, type: "uint16", value: 65 },
    { num: 4, type: "uint32", value: fitTime(START) },
  ],
});

type SessionValues = {
  start?: string;
  sport?: number | null;
  subSport?: number | null;
  distanceCm?: number | null;
  ascent?: number | null;
  avgHr?: number | null;
  maxHr?: number | null;
};

function session(
  values: SessionValues = {},
  extra: Partial<FitMessageSpec> = {},
): FitMessageSpec {
  const start = fitTime(values.start ?? START);
  const fields: FitFieldSpec[] = [
    { num: 253, type: "uint32", value: start + 3130 },
    { num: 2, type: "uint32", value: start },
    {
      num: 5,
      type: "enum",
      value: values.sport === undefined ? 1 : values.sport,
    },
    {
      num: 6,
      type: "enum",
      value: values.subSport === undefined ? 0 : values.subSport,
    },
    { num: 7, type: "uint32", value: 3_200_400 }, // 3 200,4 s
    { num: 8, type: "uint32", value: 3_130_600 }, // 3 130,6 s
    {
      num: 9,
      type: "uint32",
      value: values.distanceCm === undefined ? 1_020_050 : values.distanceCm,
    },
    {
      num: 16,
      type: "uint8",
      value: values.avgHr === undefined ? 152 : values.avgHr,
    },
    {
      num: 17,
      type: "uint8",
      value: values.maxHr === undefined ? 178 : values.maxHr,
    },
    {
      num: 22,
      type: "uint16",
      value: values.ascent === undefined ? 85 : values.ascent,
    },
  ];
  return { global: 18, fields, ...extra };
}

function record(
  index: number,
  extra: Partial<FitMessageSpec> = {},
): FitMessageSpec {
  return {
    global: 20,
    local: 1,
    fields: [
      { num: 253, type: "uint32", value: fitTime(START) + index },
      { num: 3, type: "uint8", value: 150 },
      { num: 5, type: "uint32", value: index * 280 },
      { num: 0, type: "uint32", value: 0x7fffffff },
    ],
    ...extra,
  };
}

const EXPECTED_RUN: FitSummary = {
  startDate: START,
  sport: 1,
  subSport: 0,
  sportType: "Run",
  device: "suunto",
  distanceM: 10200.5,
  movingTimeS: 3131,
  elapsedTimeS: 3200,
  elevationGainM: 85,
  averageHeartrate: 152,
  maxHeartrate: 178,
};

function summaryOf(bytes: Uint8Array): FitSummary {
  const result = decodeFitSummary(bytes);
  if (!result.ok) throw new Error(`FIT refusé : ${result.error}`);
  return result.summary;
}

describe("decodeFitSummary", () => {
  it("lit le résumé d'une séance de course simple", () => {
    expect(summaryOf(encodeFit([fileId(), session()]))).toEqual(EXPECTED_RUN);
  });

  it("lit les messages en big endian", () => {
    const bigEndian = { bigEndian: true };
    const bytes = encodeFit([
      { ...fileId(), ...bigEndian },
      session({}, bigEndian),
    ]);
    expect(summaryOf(bytes)).toEqual(EXPECTED_RUN);
  });

  it("accepte un en-tête de 12 octets et un en-tête de 14 octets sans CRC", () => {
    expect(
      summaryOf(encodeFit([fileId(), session()], { headerSize: 12 })),
    ).toEqual(EXPECTED_RUN);
    const noHeaderCrc = encodeFit([fileId(), session()], { headerCrc: false });
    expect(summaryOf(noHeaderCrc)).toEqual(EXPECTED_RUN);
  });

  it("gère les en-têtes à horodatage compressé", () => {
    const records = [0, 1, 2].map((i) =>
      record(i, { compressedTimeOffset: i }),
    );
    const bytes = encodeFit([
      fileId(),
      record(0),
      ...records,
      session({}, { local: 2, compressedTimeOffset: 5 }),
    ]);
    const scan = inspectFit(bytes);
    expect(scan.result).toEqual({ ok: true, summary: EXPECTED_RUN });
    expect(scan.skippedMessages).toBe(4);
  });

  it("saute les champs développeur", () => {
    const developerFields = [
      { num: 0, size: 2, index: 0 },
      { num: 1, size: 5, index: 0 },
    ];
    const bytes = encodeFit([
      fileId(),
      { global: 207, fields: [{ num: 3, type: "uint8", value: 0 }], local: 3 },
      record(0, { developerFields }),
      session({}, { developerFields }),
    ]);
    expect(summaryOf(bytes)).toEqual(EXPECTED_RUN);
  });

  it("saute 3 600 record sans les décoder", () => {
    const records = Array.from({ length: 3600 }, (_, i) => record(i));
    const scan = inspectFit(encodeFit([fileId(), ...records, session()]));
    expect(scan.result).toEqual({ ok: true, summary: EXPECTED_RUN });
    expect(scan.skippedMessages).toBe(3600);
    expect(scan.decodedMessages).toBe(2); // file_id et session
  });

  it("retient la première session de course d'un multisport", () => {
    const bytes = encodeFit([
      fileId(),
      session({ sport: 2, distanceCm: 4_000_000 }),
      session({ sport: 1, subSport: 3, distanceCm: 1_000_000 }),
      session({ sport: 1, distanceCm: 500_000 }),
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      sportType: "TrailRun",
      distanceM: 10000,
    });
  });

  it("retient la première session sans session de course", () => {
    const bytes = encodeFit([
      fileId(),
      session({ sport: 5, distanceCm: 150_000 }),
      session({ sport: 2, distanceCm: 4_000_000 }),
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      sportType: "Swim",
      distanceM: 1500,
    });
  });

  it("prend le sport du message sport quand la session ne le donne pas", () => {
    const sport: FitMessageSpec = {
      global: 12,
      local: 4,
      fields: [
        { num: 0, type: "enum", value: 1 },
        { num: 1, type: "enum", value: 1 },
      ],
    };
    const bytes = encodeFit([
      fileId(),
      sport,
      session({ sport: null, subSport: null }),
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      sport: 1,
      subSport: 1,
      sportType: "VirtualRun",
    });
  });

  it("renvoie null pour les valeurs invalides FIT", () => {
    const bytes = encodeFit([
      fileId(null),
      session({ ascent: null, avgHr: null, maxHr: null, distanceCm: null }),
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      device: null,
      distanceM: 0,
      elevationGainM: null,
      averageHeartrate: null,
      maxHeartrate: null,
    });
  });

  it("donne le numéro du fabricant quand il est inconnu", () => {
    expect(summaryOf(encodeFit([fileId(9999), session()])).device).toBe("9999");
  });

  it.each([
    [1, 3, "TrailRun"],
    [1, 1, "VirtualRun"],
    [1, 58, "VirtualRun"],
    [1, 2, "Run"],
    [2, 0, "Ride"],
    [11, 0, "Walk"],
    [17, 0, "Hike"],
    [5, 0, "Swim"],
    [10, 0, "Workout"],
    [null, null, "Workout"],
  ])(
    "convertit sport %s / sub_sport %s en %s",
    (sport, subSport, sportType) => {
      const bytes = encodeFit([fileId(), session({ sport, subSport })]);
      expect(summaryOf(bytes).sportType).toBe(sportType);
    },
  );

  it("répond no_session sans message session", () => {
    const bytes = encodeFit([fileId(), record(0), record(1)]);
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "no_session" });
  });

  it("répond invalid pour un fichier tronqué", () => {
    const bytes = encodeFit([fileId(), record(0), session()]);
    expect(decodeFitSummary(bytes.slice(0, bytes.length - 10))).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(decodeFitSummary(bytes.slice(0, 13))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("répond invalid quand un CRC est faux", () => {
    const fileCrc = encodeFit([fileId(), session()]);
    fileCrc[20] = (fileCrc[20] ?? 0) ^ 0x01;
    expect(decodeFitSummary(fileCrc)).toEqual({ ok: false, error: "invalid" });
    const headerCrc = encodeFit([fileId(), session()]);
    headerCrc[12] = (headerCrc[12] ?? 0) ^ 0x01;
    expect(decodeFitSummary(headerCrc)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("répond invalid pour un message sans définition", () => {
    // En-tête de données du type local 5, jamais défini.
    expect(decodeFitSummary(wrapFitData([0x05, 0x00]))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("répond not_fit sans signature FIT", () => {
    const notFit = (bytes: number[]) => decodeFitSummary(new Uint8Array(bytes));
    expect(notFit([])).toEqual({ ok: false, error: "not_fit" });
    expect(
      notFit([..."%PDF-1.7 hello world"].map((char) => char.charCodeAt(0))),
    ).toEqual({
      ok: false,
      error: "not_fit",
    });
    const wrongSignature = encodeFit([fileId(), session()]);
    wrongSignature[9] = 0x47;
    expect(decodeFitSummary(wrongSignature)).toEqual({
      ok: false,
      error: "not_fit",
    });
  });
});

describe("décodage d'un vrai FIT Suunto (anonymisé, positions neutralisées)", () => {
  const bytes = dataUrlBytes(suuntoRunDataUrl);

  it("lit le résumé de la séance", () => {
    expect(bytes.length).toBe(192517);
    expect(summaryOf(bytes)).toEqual({
      startDate: "2026-10-23T10:05:58Z",
      sport: 1,
      subSport: null,
      sportType: "Run",
      device: "suunto",
      distanceM: 13106,
      movingTimeS: 6245, // 6 245,14 s
      elapsedTimeS: 6253,
      elevationGainM: 141,
      averageHeartrate: 169,
      maxHeartrate: 186,
    });
  });

  it("saute les 5 963 record et ne décode que file_id et la session", () => {
    const scan = inspectFit(bytes);
    expect(scan.decodedMessages).toBe(2);
    // 5 963 record + 14 lap + 4 messages développeur + 11 device_info + 4 event + 1 activity.
    expect(scan.skippedMessages).toBe(5997);
  });
});

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Décodage base64 pur : src/core n'a pas les API DOM (`atob`) dans son tsconfig.
function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((base64.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (const char of base64) {
    buffer = ((buffer << 6) | BASE64.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[length++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}
