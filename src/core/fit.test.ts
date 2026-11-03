import { describe, expect, it } from "vitest";
import { decodeFitSummary, fitCrc, inspectFit, type FitSummary } from "./fit";
import {
  encodeFit,
  fitTime,
  type FitFieldSpec,
  type FitMessageSpec,
  wrapFitData,
} from "./fit.test-helpers";
import suuntoRunDataUrl from "./fixtures/fit/suunto-run-anonymized.fit?inline";

declare const performance: { now(): number };

const START = "2026-11-03T07:30:00Z";
const MIB_1_5 = 1.5 * 1024 * 1024;

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

  it.each([129, 294])("reconnaît Coros (fabricant %s)", (manufacturer) => {
    expect(summaryOf(encodeFit([fileId(manufacturer), session()])).device).toBe(
      "coros",
    );
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

describe("champs lus avec leur type attendu", () => {
  it("donne null à un champ d'un autre type de base que celui du profil", () => {
    const bytes = encodeFit([
      fileId(),
      {
        global: 18,
        fields: [
          { num: 2, type: "uint32", value: fitTime(START) },
          { num: 5, type: "uint8", value: 1 }, // sport : enum attendu
          { num: 8, type: "uint32", value: 1_800_000 },
          { num: 9, type: "uint32z", value: 500_000 }, // distance : uint32 attendu
          { num: 16, type: "uint16", value: 150 }, // FC moyenne : uint8 attendu
          { num: 22, type: "uint32", value: 40 }, // D+ : uint16 attendu
        ],
      },
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      sport: null,
      distanceM: 0,
      movingTimeS: 1800,
      averageHeartrate: null,
      elevationGainM: null,
    });
  });
});

describe("heure de départ", () => {
  const sessionAt = (
    startTime: number | null,
    timestamp: number | null,
  ): FitMessageSpec => ({
    global: 18,
    local: 1,
    fields: [
      { num: 253, type: "uint32", value: timestamp },
      { num: 2, type: "uint32", value: startTime },
      { num: 7, type: "uint32", value: 3_600_400 }, // 3 600,4 s
      { num: 8, type: "uint32", value: 3_500_000 },
    ],
  });
  const created = (time: number | null): FitMessageSpec => ({
    global: 0,
    fields: [{ num: 4, type: "uint32", value: time }],
  });
  const end = fitTime(START) + 3600;

  it("prend la fin de session moins le temps écoulé sans start_time", () => {
    const bytes = encodeFit([
      created(fitTime("2026-11-03T07:00:00Z")),
      sessionAt(null, end),
    ]);
    expect(summaryOf(bytes).startDate).toBe(START);
  });

  it("ignore les dates relatives (< 0x10000000) et passe à la source suivante", () => {
    expect(
      summaryOf(encodeFit([created(fitTime(START)), sessionAt(5000, 9000)]))
        .startDate,
    ).toBe(START);
    expect(summaryOf(encodeFit([sessionAt(5000, end)])).startDate).toBe(START);
  });

  it("répond invalid sans aucune date absolue", () => {
    const bytes = encodeFit([created(0x0fffffff), sessionAt(5000, 9000)]);
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("séance vide", () => {
  const sessionWith = (fields: FitFieldSpec[]) =>
    encodeFit([
      {
        global: 18,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }, ...fields],
      },
    ]);

  it("répond invalid sans distance ni temps", () => {
    const bytes = sessionWith([
      { num: 7, type: "uint32", value: null },
      { num: 8, type: "uint32", value: null },
      { num: 9, type: "uint32", value: null },
    ]);
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "invalid" });
  });

  it("garde une séance qui n'a que la distance ou que le temps", () => {
    expect(
      summaryOf(sessionWith([{ num: 9, type: "uint32", value: 300_000 }])),
    ).toMatchObject({
      distanceM: 3000,
      movingTimeS: 0,
    });
    expect(
      summaryOf(sessionWith([{ num: 8, type: "uint32", value: 60_000 }])),
    ).toMatchObject({
      distanceM: 0,
      movingTimeS: 60,
    });
  });
});

describe("multisport", () => {
  const sportMessage = (sport: number): FitMessageSpec => ({
    global: 12,
    local: 4,
    fields: [{ num: 0, type: "enum", value: sport }],
  });

  it("n'applique un message sport qu'à la session qui le suit", () => {
    const bytes = encodeFit([
      fileId(),
      sportMessage(1),
      session({ sport: 2, distanceCm: 4_000_000 }),
      session({ sport: null, subSport: null, distanceCm: 1_000_000 }),
    ]);
    expect(summaryOf(bytes)).toMatchObject({
      sport: 2,
      sportType: "Ride",
      distanceM: 40000,
    });
  });

  it("ne décode plus les sessions après la première session de course", () => {
    const scan = inspectFit(
      encodeFit([
        fileId(),
        session(),
        session({ sport: 2 }),
        session({ distanceCm: 1 }),
      ]),
    );
    expect(scan.result).toEqual({ ok: true, summary: EXPECTED_RUN });
    expect([scan.decodedMessages, scan.skippedMessages]).toEqual([2, 2]);
  });
});

describe("structures hostiles", () => {
  it("répond invalid pour une définition tronquée au milieu de ses champs", () => {
    const bytes = wrapFitData([0x40, 0, 0, 18, 0, 3, 2, 4, 0x86, 5, 1]);
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "invalid" });
  });

  it("répond invalid quand les champs développeur sont tronqués", () => {
    const definition = [0x60, 0, 0, 20, 0, 1, 253, 4, 0x86];
    expect(decodeFitSummary(wrapFitData(definition))).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(decodeFitSummary(wrapFitData([...definition, 2, 0, 1, 0]))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("décode en temps borné 1,5 Mio de sessions vides à 255 champs de taille 0", () => {
    const definition = [0x40, 0, 0, 18, 0, 255];
    for (let num = 0; num < 255; num++) definition.push(num, 0, 0x86);
    const emptyMessages = new Array<number>(
      MIB_1_5 - 16 - definition.length,
    ).fill(0);
    const data = definition.concat(emptyMessages);
    const bytes = wrapFitData(data);
    const start = performance.now();
    const scan = inspectFit(bytes);
    // Budget large pour la CI : il détecte une boucle quadratique, pas une régression fine.
    expect(performance.now() - start).toBeLessThan(250);
    expect(scan.result).toEqual({ ok: false, error: "invalid" });
    expect(scan.decodedMessages).toBe(MIB_1_5 - 16 - 6 - 255 * 3);
  });
});

describe("fitCrc", () => {
  // Implémentation quartet par quartet du SDK Garmin (crc-calculator.js), pour comparaison.
  const NIBBLES = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
    0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  const nibbleCrc = (bytes: Uint8Array) => {
    let crc = 0;
    for (const byte of bytes) {
      crc =
        ((crc >> 4) & 0x0fff) ^
        (NIBBLES[crc & 0xf] ?? 0) ^
        (NIBBLES[byte & 0xf] ?? 0);
      crc =
        ((crc >> 4) & 0x0fff) ^
        (NIBBLES[crc & 0xf] ?? 0) ^
        (NIBBLES[byte >> 4] ?? 0);
    }
    return crc;
  };

  it("donne la valeur de référence de CRC-16/ARC", () => {
    const check = Uint8Array.from("123456789", (char) => char.charCodeAt(0));
    expect(fitCrc(check, 0, check.length)).toBe(0xbb3d);
  });

  it("donne les mêmes résultats que l'implémentation du SDK", () => {
    const bytes = Uint8Array.from(
      { length: 4096 },
      (_, i) => (i * 7919 + (i >> 3)) & 0xff,
    );
    for (const length of [0, 1, 2, 13, 255, 4096]) {
      const slice = bytes.subarray(0, length);
      expect(fitCrc(slice, 0, length)).toBe(nibbleCrc(slice));
    }
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
