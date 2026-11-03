// Robustesse du décodeur FIT (issue #67) : il recevra des fichiers arbitraires via l'endpoint de #68.
// Fuzzing déterministe (graine fixe), structures limites et temps de décodage borné.
import { describe, expect, it } from "vitest";
import { decodeFitSummary, fitCrc, inspectFit, type FitResult } from "./fit";
import { encodeFit, fitTime, wrapFitData } from "./fit-test-encoder";
import suuntoRunDataUrl from "./fixtures/fit/suunto-run-anonymized.fit?inline";

declare const performance: { now(): number };

const MIB_4 = 4 * 1024 * 1024;
const START = "2026-11-03T07:30:00Z";
const ERRORS = ["not_fit", "invalid", "no_session"];
const SPORT_TYPES = [
  "Run",
  "TrailRun",
  "VirtualRun",
  "Ride",
  "Walk",
  "Hike",
  "Swim",
  "Workout",
];

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE_TYPE_SIZES = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];

// Générateur pseudo-aléatoire à graine fixe (mulberry32) : mêmes entrées à chaque exécution.
function seededRandom(seed: number): (max: number) => number {
  let state = seed;
  return (max) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * max);
  };
}

// Recalcule les CRC d'en-tête et de fichier pour que les octets corrompus atteignent le parseur.
function withValidCrcs(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 14) view.setUint16(12, fitCrc(bytes, 0, 12), true);
  const dataEnd = (bytes[0] ?? 0) + view.getUint32(4, true);
  if (dataEnd + 2 <= bytes.length) {
    view.setUint16(dataEnd, fitCrc(bytes, 0, dataEnd), true);
  }
  return bytes;
}

function randomBytes(
  random: (max: number) => number,
  length: number,
): number[] {
  return Array.from({ length }, () => random(256));
}

// Un résultat est cohérent : erreur connue, ou résumé aux valeurs finies, positives et datées.
function expectConsistent(result: FitResult): void {
  if (!result.ok) {
    expect(ERRORS).toContain(result.error);
    return;
  }
  const { summary } = result;
  expect(summary.startDate).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(SPORT_TYPES).toContain(summary.sportType);
  for (const value of [
    summary.distanceM,
    summary.movingTimeS,
    summary.elapsedTimeS,
  ]) {
    expect(Number.isFinite(value) && value >= 0).toBe(true);
  }
}

const fixture = dataUrlBytes(suuntoRunDataUrl);
const syntheticRun = encodeFit([
  {
    global: 0,
    fields: [
      { num: 1, type: "uint16", value: 23 },
      { num: 4, type: "uint32", value: fitTime(START) },
    ],
  },
  ...Array.from({ length: 50 }, (_, i) => ({
    global: 20,
    local: 1,
    fields: [{ num: 253, type: "uint32" as const, value: fitTime(START) + i }],
  })),
  {
    global: 18,
    local: 2,
    fields: [
      { num: 2, type: "uint32", value: fitTime(START) },
      { num: 5, type: "enum", value: 1 },
      { num: 9, type: "uint32", value: 1_000_000 },
    ],
  },
]);

describe("décodeur FIT face à des entrées corrompues (fuzzing à graine fixe)", () => {
  it("rejette sans exception les flips de bits aléatoires (CRC non recalculés)", () => {
    const random = seededRandom(1);
    for (let i = 0; i < 200; i++) {
      const bytes = syntheticRun.slice();
      const at = random(bytes.length);
      bytes[at] = (bytes[at] ?? 0) ^ (1 << random(8));
      expectConsistent(decodeFitSummary(bytes));
    }
  });

  it("reste cohérent après des flips de bits dans un vrai FIT aux CRC recalculés", () => {
    const random = seededRandom(2);
    for (let i = 0; i < 300; i++) {
      const bytes = fixture.slice();
      for (let flips = 1 + random(8); flips > 0; flips--) {
        const at = random(i % 2 === 0 ? 3000 : bytes.length);
        bytes[at] = (bytes[at] ?? 0) ^ (1 << random(8));
      }
      expectConsistent(decodeFitSummary(withValidCrcs(bytes)));
    }
  });

  it("reste cohérent après des flips de bits dans un FIT synthétique aux CRC recalculés", () => {
    const random = seededRandom(3);
    for (let i = 0; i < 2000; i++) {
      const bytes = syntheticRun.slice();
      const at = 14 + random(bytes.length - 16);
      bytes[at] = (bytes[at] ?? 0) ^ (1 << random(8));
      expectConsistent(decodeFitSummary(withValidCrcs(bytes)));
    }
  });

  it("répond invalid ou not_fit à chaque troncature des 2 000 premiers octets", () => {
    for (let length = 0; length <= 2000; length++) {
      const result = decodeFitSummary(fixture.slice(0, length));
      expect(result).toEqual({
        ok: false,
        error: length < 12 ? "not_fit" : "invalid",
      });
    }
  });

  it("reste cohérent à chaque troncature des 2 000 premiers octets avec taille et CRC réécrits", () => {
    for (let length = 16; length <= 2000; length++) {
      const bytes = fixture.slice(0, length);
      new DataView(bytes.buffer).setUint32(4, length - 16, true);
      const result = decodeFitSummary(withValidCrcs(bytes));
      expect(result.ok).toBe(false); // la session est à la fin du fichier
      expectConsistent(result);
    }
  });

  it("reste cohérent sur des données aléatoires enveloppées dans un FIT valide", () => {
    const random = seededRandom(4);
    for (let i = 0; i < 1000; i++) {
      const data = randomBytes(random, random(600));
      expectConsistent(decodeFitSummary(wrapFitData(data)));
    }
  });

  it("répond not_fit à des octets aléatoires sans en-tête FIT", () => {
    const random = seededRandom(5);
    for (let i = 0; i < 500; i++) {
      const bytes = new Uint8Array(randomBytes(random, random(64)));
      bytes[11] = 0; // pas de signature ".FIT"
      expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "not_fit" });
    }
  });
});

describe("décodeur FIT face à des structures limites", () => {
  it("répond invalid quand la taille annoncée dépasse le fichier", () => {
    const bytes = syntheticRun.slice();
    new DataView(bytes.buffer).setUint32(4, 0xffffffff, true);
    expect(decodeFitSummary(withValidCrcs(bytes))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("ignore les octets au-delà de la taille annoncée quand le CRC est à sa place", () => {
    const extended = new Uint8Array(syntheticRun.length + 100).fill(0xee);
    extended.set(syntheticRun);
    expect(decodeFitSummary(extended)).toEqual(decodeFitSummary(syntheticRun));
  });

  it("répond invalid quand la taille annoncée coupe un message", () => {
    const bytes = syntheticRun.slice();
    new DataView(bytes.buffer).setUint32(4, bytes.length - 16 - 3, true);
    expect(decodeFitSummary(withValidCrcs(bytes))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("répond invalid pour un fichier de 14 octets réduit à l'en-tête", () => {
    expect(decodeFitSummary(wrapFitData([]).slice(0, 14))).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("répond no_session pour un fichier sans données", () => {
    expect(decodeFitSummary(wrapFitData([]))).toEqual({
      ok: false,
      error: "no_session",
    });
  });

  it("répond invalid quand le CRC d'en-tête est nul et le CRC de fichier faux", () => {
    const bytes = encodeFit([{ global: 18, fields: [] }], { headerCrc: false });
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "invalid" });
  });

  it("lit un Uint8Array qui ne commence pas au début de son buffer", () => {
    const shifted = new Uint8Array(syntheticRun.length + 7);
    shifted.set(syntheticRun, 7);
    expect(decodeFitSummary(shifted.subarray(7))).toEqual(
      decodeFitSummary(syntheticRun),
    );
  });

  it("lit une session définie avec 255 champs", () => {
    // Champs de type byte (non lus), sauf avg_heart_rate : start_time vient alors de file_id.
    const fields = Array.from({ length: 255 }, (_, num) => ({
      num,
      type: num === 16 ? ("uint8" as const) : ("byte" as const),
      value: num === 16 ? 150 : 7,
    }));
    const bytes = encodeFit([
      {
        global: 0,
        fields: [{ num: 4, type: "uint32", value: fitTime(START) }],
      },
      { global: 18, local: 1, fields },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { startDate: START, averageHeartrate: 150, distanceM: 0 },
    });
  });

  it("donne null à un champ de taille 0 ou non multiple de son type, sans décaler les suivants", () => {
    const bytes = encodeFit([
      {
        global: 18,
        fields: [
          { num: 2, type: "uint32", value: fitTime(START) },
          { num: 16, type: "uint8", value: 0, size: 0 }, // avg_heart_rate de taille 0
          { num: 9, type: "uint32", value: 0x010203, size: 3 }, // distance sur 3 octets
          { num: 17, type: "uint8", value: 181 },
        ],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { averageHeartrate: null, distanceM: 0, maxHeartrate: 181 },
    });
  });

  it("utilise la dernière définition d'un type local redéfini en cours de route", () => {
    const bytes = encodeFit([
      { global: 20, fields: [{ num: 253, type: "uint32", value: 1 }] },
      {
        global: 18,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }],
      },
      { global: 20, fields: [{ num: 3, type: "uint8", value: 140 }] },
    ]);
    const scan = inspectFit(bytes);
    expect(scan.result).toMatchObject({
      ok: true,
      summary: { startDate: START },
    });
    expect([scan.decodedMessages, scan.skippedMessages]).toEqual([1, 2]);
  });

  it("accepte un horodatage compressé avant tout horodatage complet", () => {
    const bytes = encodeFit([
      {
        global: 20,
        fields: [{ num: 3, type: "uint8", value: 140 }],
        compressedTimeOffset: 31,
      },
      {
        global: 18,
        local: 1,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { startDate: START },
    });
  });

  it("répond invalid pour un horodatage compressé vers un type local non défini", () => {
    const bytes = encodeFit([
      {
        global: 18,
        local: 4,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }],
      },
    ]);
    // 0xE0 : horodatage compressé, type local 3, jamais défini.
    const data = [...bytes.slice(14, bytes.length - 2), 0xe0];
    expect(decodeFitSummary(wrapFitData(data))).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

describe("valeurs absentes ou invalides de la session", () => {
  it("prend sub_sport trail de la session sans message sport", () => {
    const bytes = encodeFit([
      {
        global: 18,
        fields: [
          { num: 2, type: "uint32", value: fitTime(START) },
          { num: 5, type: "enum", value: 1 },
          { num: 6, type: "enum", value: 3 },
        ],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { sportType: "TrailRun" },
    });
  });

  it("prend le sport du message sport quand la session n'a pas de champ sport", () => {
    const bytes = encodeFit([
      { global: 12, local: 1, fields: [{ num: 0, type: "enum", value: 1 }] },
      {
        global: 18,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { sport: 1, subSport: null, sportType: "Run" },
    });
  });

  it("lit une session sans file_id : appareil inconnu", () => {
    const bytes = encodeFit([
      {
        global: 18,
        fields: [{ num: 2, type: "uint32", value: fitTime(START) }],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: {
        startDate: START,
        device: null,
        sport: null,
        sportType: "Workout",
      },
    });
  });

  it("répond invalid sans heure de départ ni time_created", () => {
    const bytes = encodeFit([
      { global: 0, fields: [{ num: 1, type: "uint16", value: 23 }] },
      { global: 18, fields: [{ num: 2, type: "uint32", value: null }] },
    ]);
    expect(decodeFitSummary(bytes)).toEqual({ ok: false, error: "invalid" });
  });

  it("prend time_created de file_id quand start_time est invalide", () => {
    const bytes = encodeFit([
      {
        global: 0,
        fields: [{ num: 4, type: "uint32", value: fitTime(START) }],
      },
      {
        global: 18,
        local: 1,
        fields: [{ num: 2, type: "uint32", value: null }],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      ok: true,
      summary: { startDate: START },
    });
  });

  it("reprend le temps chronométré quand le temps écoulé est invalide, et inversement", () => {
    const sessionWith = (elapsed: number | null, timer: number | null) =>
      encodeFit([
        {
          global: 18,
          fields: [
            { num: 2, type: "uint32", value: fitTime(START) },
            { num: 7, type: "uint32", value: elapsed },
            { num: 8, type: "uint32", value: timer },
          ],
        },
      ]);
    expect(decodeFitSummary(sessionWith(null, 1_800_400))).toMatchObject({
      summary: { movingTimeS: 1800, elapsedTimeS: 1800 },
    });
    expect(decodeFitSummary(sessionWith(2_000_000, null))).toMatchObject({
      summary: { movingTimeS: 2000, elapsedTimeS: 2000 },
    });
  });

  it("donne une FC nulle pour 0xFF et un D+ nul pour 0xFFFF", () => {
    const bytes = encodeFit([
      {
        global: 18,
        fields: [
          { num: 2, type: "uint32", value: fitTime(START) },
          { num: 16, type: "uint8", value: 0xff },
          { num: 17, type: "uint8", value: 0xff },
          { num: 22, type: "uint16", value: 0xffff },
        ],
      },
    ]);
    expect(decodeFitSummary(bytes)).toMatchObject({
      summary: {
        averageHeartrate: null,
        maxHeartrate: null,
        elevationGainM: null,
      },
    });
  });
});

describe("vrai FIT Suunto (big endian) converti en little endian", () => {
  it("donne le même résumé et les mêmes compteurs qu'en little endian", () => {
    expect(fixture[16]).toBe(1); // architecture de la 1re définition : big endian
    const littleEndian = withFlippedEndianness(fixture);
    expect(littleEndian[16]).toBe(0);
    expect(inspectFit(littleEndian)).toEqual(inspectFit(fixture));
  });
});

describe("temps de décodage borné sur 4 Mio", () => {
  // Budget large pour la CI : il détecte une boucle quadratique ou infinie, pas une régression fine.
  const BUDGET_MS = 250;

  const cases: [string, () => number[]][] = [
    ["octets aléatoires", () => randomBytes(seededRandom(6), MIB_4 - 16)],
    [
      "messages vides d'un octet",
      () => {
        const data = new Array<number>(MIB_4 - 16).fill(0);
        data.splice(0, 6, 0x40, 0, 0, 20, 0, 0); // type local 0 : record sans champ
        return data;
      },
    ],
    [
      "définitions de 255 champs en boucle",
      () => {
        const definition = [0x40, 0, 0, 18, 0, 255];
        for (let num = 0; num < 255; num++) definition.push(num, 0, 0x86);
        const data: number[] = [];
        while (data.length + definition.length + 1 < MIB_4 - 16)
          data.push(...definition, 0);
        return data;
      },
    ],
  ];

  it.each(cases)("décode 4 Mio de %s dans le budget", (_, build) => {
    const bytes = wrapFitData(build());
    const start = performance.now();
    const result = decodeFitSummary(bytes);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    expectConsistent(result);
  });
});

// Inverse l'endianness d'un FIT : architecture, numéro global et octets de chaque élément de
// champ. Les champs développeur, sautés par le décodeur, sont copiés tels quels.
function withFlippedEndianness(source: Uint8Array): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer);
  const definitions: { fields: [number, number][]; devSize: number }[] = [];
  const end = (bytes[0] ?? 0) + view.getUint32(4, true);
  let pos = bytes[0] ?? 0;
  while (pos < end) {
    const header = bytes[pos++] ?? 0;
    if ((header & 0xc0) === 0x40) {
      bytes[pos + 1] = bytes[pos + 1] === 0 ? 1 : 0;
      bytes.subarray(pos + 2, pos + 4).reverse();
      const count = bytes[pos + 4] ?? 0;
      const fields: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const at = pos + 5 + i * 3;
        fields.push([
          bytes[at + 1] ?? 0,
          BASE_TYPE_SIZES[(bytes[at + 2] ?? 0) & 0x1f] ?? 1,
        ]);
      }
      pos += 5 + count * 3;
      let devSize = 0;
      if (header & 0x20) {
        const devCount = bytes[pos++] ?? 0;
        for (let i = 0; i < devCount; i++)
          devSize += bytes[pos + i * 3 + 1] ?? 0;
        pos += devCount * 3;
      }
      definitions[header & 0x0f] = { fields, devSize };
      continue;
    }
    const definition =
      definitions[header & 0x80 ? (header >> 5) & 3 : header & 0x0f];
    if (!definition) throw new Error("FIT de référence inattendu");
    for (const [size, elementSize] of definition.fields) {
      for (let at = pos; at + elementSize <= pos + size; at += elementSize) {
        bytes.subarray(at, at + elementSize).reverse();
      }
      pos += size;
    }
    pos += definition.devSize;
  }
  return withValidCrcs(bytes);
}

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
