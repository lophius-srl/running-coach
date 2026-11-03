// Décodeur FIT minimal (ADR 0005, issue #67) : lit le résumé d'une séance, sans I/O ni dépendance.
// Ne décode que file_id (0), sport (12) et session (18) ; tout autre message (dont les milliers de
// `record`) est sauté grâce à la taille donnée par sa définition, sans allocation.
//
// Sources (consultées le 2026-11-03) :
// - Protocole FIT : https://developer.garmin.com/fit/protocol/ (en-tête de fichier 12 ou 14 octets,
//   signature ".FIT", en-têtes d'enregistrement normal / à horodatage compressé, définitions).
// - SDK FIT JavaScript officiel de Garmin, @garmin/fitsdk 21.218.0 (archive npm, Profile 21.218.0) :
//   decoder.js (masques 0x80 / 0x40 / 0x20 / 0x0F, architecture 0 = little endian, CRC d'en-tête
//   ignoré s'il vaut 0, CRC de fichier sur en-tête + données), crc-calculator.js (CRC-16, ici sous
//   sa forme CRC-16/ARC à 256 entrées), fit.js (types de base et valeurs invalides), utils.js
//   (époque FIT 631065600 s = 1989-12-31Z), profile.js (numéros de messages et de champs, types,
//   échelles, énumérations sport / sub_sport / manufacturer, date_time < 0x10000000 = temps système).
import type { StravaSportType } from "./run-types";

export type FitSummary = {
  startDate: string; // ISO 8601 UTC à la seconde, ex. "2026-10-23T10:05:58Z"
  sport: number | null; // énumération FIT `sport` brute
  subSport: number | null; // énumération FIT `sub_sport` brute
  sportType: StravaSportType;
  device: string | null; // fabricant lisible (« suunto ») ou son numéro FIT
  distanceM: number;
  movingTimeS: number; // total_timer_time (pauses exclues), arrondi à la seconde
  elapsedTimeS: number; // total_elapsed_time, arrondi à la seconde
  elevationGainM: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
};

export type FitError = "not_fit" | "invalid" | "no_session";

export type FitResult =
  { ok: true; summary: FitSummary } | { ok: false; error: FitError };

// Résultat plus compteurs : les tests vérifient ainsi que les `record` sont sautés, pas décodés.
export type FitScan = {
  result: FitResult;
  decodedMessages: number;
  skippedMessages: number;
};

const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z
const DATE_TIME_MIN = 0x10000000; // en dessous : secondes depuis l'allumage de l'appareil
const CRC_SIZE = 2;

const SPORT_RUNNING = 1;
const SPORT_CYCLING = 2;
const SPORT_SWIMMING = 5;
const SPORT_WALKING = 11;
const SPORT_HIKING = 17;
const SUB_SPORT_TREADMILL = 1;
const SUB_SPORT_TRAIL = 3;
const SUB_SPORT_VIRTUAL_ACTIVITY = 58;

const MANUFACTURERS: ReadonlyMap<number, string> = new Map([
  [1, "garmin"],
  [23, "suunto"],
  [32, "wahoo"],
  [95, "stryd"],
  [123, "polar"],
  [129, "coros"], // corosByte
  [260, "zwift"],
  [294, "coros"],
]);

// Types de base attendus (fit.js) : taille et valeur invalide.
const ENUM = 0x00;
const UINT8 = 0x02;
const UINT16 = 0x04;
const UINT32 = 0x06;
const BASE_TYPES: Record<number, { size: number; invalid: number }> = {
  [ENUM]: { size: 1, invalid: 0xff },
  [UINT8]: { size: 1, invalid: 0xff },
  [UINT16]: { size: 2, invalid: 0xffff },
  [UINT32]: { size: 4, invalid: 0xffffffff },
};

// Champs lus, par message : [numéro de champ, type de base attendu] ; l'indice est le « slot ».
type Wanted = readonly (readonly [number, number])[];
const FILE_ID_FIELDS: Wanted = [
  [1, UINT16], // manufacturer
  [4, UINT32], // time_created
];
const SPORT_FIELDS: Wanted = [
  [0, ENUM], // sport
  [1, ENUM], // sub_sport
];
const SESSION_FIELDS: Wanted = [
  [253, UINT32], // timestamp
  [2, UINT32], // start_time
  [5, ENUM], // sport
  [6, ENUM], // sub_sport
  [7, UINT32], // total_elapsed_time (s × 1000)
  [8, UINT32], // total_timer_time (s × 1000)
  [9, UINT32], // total_distance (m × 100)
  [16, UINT8], // avg_heart_rate
  [17, UINT8], // max_heart_rate
  [22, UINT16], // total_ascent (m)
];
const [MANUFACTURER, TIME_CREATED] = [0, 1];
const [SPORT, SUB_SPORT] = [0, 1];
const [
  TIMESTAMP,
  START_TIME,
  S_SPORT,
  S_SUB_SPORT,
  ELAPSED,
  TIMER,
  DISTANCE,
  AVG_HR,
  MAX_HR,
  ASCENT,
] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

type MessageSpec = { wanted: Wanted; slotOf: Int8Array }; // slotOf[numéro de champ] → slot ou -1

const MESSAGES: ReadonlyMap<number, MessageSpec> = new Map([
  [0, messageSpec(FILE_ID_FIELDS)],
  [12, messageSpec(SPORT_FIELDS)],
  [18, messageSpec(SESSION_FIELDS)],
]);
const [MESG_FILE_ID, MESG_SPORT] = [0, 12];

function messageSpec(wanted: Wanted): MessageSpec {
  const slotOf = new Int8Array(256).fill(-1);
  wanted.forEach(([num], slot) => (slotOf[num] = slot));
  return { wanted, slotOf };
}

type MessageDefinition = {
  globalNum: number;
  littleEndian: boolean;
  size: number; // champs normaux + champs développeur
  offsets: Int32Array | null; // décalage de chaque slot (-1 : absent) ; null pour un message sauté
  end: number; // position qui suit la définition
};

type Session = {
  timestamp: number | null;
  startTime: number | null;
  sport: number | null;
  subSport: number | null;
  elapsedMs: number | null;
  timerMs: number | null;
  distanceCm: number | null;
  ascentM: number | null;
  avgHr: number | null;
  maxHr: number | null;
};

class InvalidFit extends Error {}

// CRC-16 FIT = CRC-16/ARC (polynôme réfléchi 0xA001, valeur initiale 0), table de 256 entrées.
const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint16Array {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    table[n] = crc;
  }
  return table;
}

export function fitCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0);
  }
  return crc;
}

export function decodeFitSummary(bytes: Uint8Array): FitResult {
  return inspectFit(bytes).result;
}

export function inspectFit(bytes: Uint8Array): FitScan {
  const scan: FitScan = {
    result: fail("invalid"),
    decodedMessages: 0,
    skippedMessages: 0,
  };
  const headerSize = bytes[0];
  if (
    bytes.length < 12 ||
    (headerSize !== 12 && headerSize !== 14) ||
    !hasFitSignature(bytes)
  ) {
    scan.result = fail("not_fit");
    return scan;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataEnd = headerSize + view.getUint32(4, true);
  if (bytes.length < dataEnd + CRC_SIZE) return scan;
  if (headerSize === 14) {
    const headerCrc = view.getUint16(12, true);
    if (headerCrc !== 0 && headerCrc !== fitCrc(bytes, 0, 12)) return scan;
  }
  if (view.getUint16(dataEnd, true) !== fitCrc(bytes, 0, dataEnd)) return scan;
  try {
    scan.result = readRecords(view, headerSize, dataEnd, scan);
  } catch (error) {
    if (!(error instanceof InvalidFit)) throw error;
  }
  return scan;
}

function hasFitSignature(bytes: Uint8Array): boolean {
  return (
    bytes[8] === 0x2e &&
    bytes[9] === 0x46 &&
    bytes[10] === 0x49 &&
    bytes[11] === 0x54
  );
}

function fail(error: FitError): FitResult {
  return { ok: false, error };
}

type DecodeState = {
  manufacturer: number | null;
  timeCreated: number | null;
  pendingSport: number | null; // message sport : ne vaut que pour la session qui le suit
  pendingSubSport: number | null;
  firstSession: Session | null;
  runSession: Session | null;
};

// Boucle chaude : un octet d'en-tête lu et un saut par message, sans allocation ni closure.
function readRecords(
  view: DataView,
  start: number,
  end: number,
  scan: FitScan,
): FitResult {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const definitions: (MessageDefinition | undefined)[] = new Array(16);
  const state: DecodeState = {
    manufacturer: null,
    timeCreated: null,
    pendingSport: null,
    pendingSubSport: null,
    firstSession: null,
    runSession: null,
  };
  let pos = start;
  while (pos < end) {
    const header = bytes[pos] ?? 0;
    if ((header & 0xc0) === 0x40) {
      const definition = readDefinition(view, pos, end, (header & 0x20) !== 0);
      definitions[header & 0x0f] = definition;
      pos = definition.end;
      continue;
    }
    // Horodatage compressé : bit 7, type local sur les bits 5–6 (0 à 3), décalage sur les bits 0–4.
    const definition =
      definitions[header & 0x80 ? (header >> 5) & 0x03 : header & 0x0f];
    if (definition === undefined) throw new InvalidFit();
    const data = pos + 1;
    pos = data + definition.size;
    if (pos > end) throw new InvalidFit();
    if (definition.offsets === null || state.runSession !== null) {
      scan.skippedMessages++;
      continue;
    }
    scan.decodedMessages++;
    decodeMessage(view, data, definition, state);
  }
  const session = state.runSession ?? state.firstSession;
  if (session === null) return fail("no_session");
  const startTime = startTimeOf(session, state.timeCreated);
  const durationMs = session.timerMs ?? session.elapsedMs;
  if (
    startTime === null ||
    (durationMs === null && session.distanceCm === null)
  ) {
    return fail("invalid");
  }
  return {
    ok: true,
    summary: toSummary(session, startTime, state.manufacturer),
  };
}

function decodeMessage(
  view: DataView,
  data: number,
  definition: MessageDefinition,
  state: DecodeState,
): void {
  if (definition.globalNum === MESG_FILE_ID) {
    state.manufacturer = readField(
      view,
      data,
      definition,
      FILE_ID_FIELDS,
      MANUFACTURER,
    );
    state.timeCreated = readField(
      view,
      data,
      definition,
      FILE_ID_FIELDS,
      TIME_CREATED,
    );
    return;
  }
  if (definition.globalNum === MESG_SPORT) {
    state.pendingSport = readField(view, data, definition, SPORT_FIELDS, SPORT);
    state.pendingSubSport = readField(
      view,
      data,
      definition,
      SPORT_FIELDS,
      SUB_SPORT,
    );
    return;
  }
  const read = (slot: number) =>
    readField(view, data, definition, SESSION_FIELDS, slot);
  const sport =
    readField(view, data, definition, SESSION_FIELDS, S_SPORT) ??
    state.pendingSport;
  const subSport =
    readField(view, data, definition, SESSION_FIELDS, S_SUB_SPORT) ??
    state.pendingSubSport;
  state.pendingSport = null;
  state.pendingSubSport = null;
  if (state.firstSession !== null && sport !== SPORT_RUNNING) return;
  const session: Session = {
    timestamp: read(TIMESTAMP),
    startTime: read(START_TIME),
    sport,
    subSport,
    elapsedMs: read(ELAPSED),
    timerMs: read(TIMER),
    distanceCm: read(DISTANCE),
    ascentM: read(ASCENT),
    avgHr: read(AVG_HR),
    maxHr: read(MAX_HR),
  };
  state.firstSession ??= session;
  if (sport === SPORT_RUNNING) state.runSession = session;
}

function readDefinition(
  view: DataView,
  pos: number,
  end: number,
  hasDeveloperFields: boolean,
): MessageDefinition {
  if (pos + 6 > end) throw new InvalidFit();
  const littleEndian = view.getUint8(pos + 2) === 0;
  const globalNum = view.getUint16(pos + 3, littleEndian);
  const fieldCount = view.getUint8(pos + 5);
  const spec = MESSAGES.get(globalNum);
  const offsets = spec ? new Int32Array(spec.wanted.length).fill(-1) : null;
  let size = 0;
  let cursor = pos + 6;
  if (cursor + fieldCount * 3 > end) throw new InvalidFit();
  for (let i = 0; i < fieldCount; i++, cursor += 3) {
    const fieldSize = view.getUint8(cursor + 1);
    const slot = spec ? (spec.slotOf[view.getUint8(cursor)] ?? -1) : -1;
    if (offsets && slot >= 0) {
      const baseType = view.getUint8(cursor + 2) & 0x1f;
      const expected = spec?.wanted[slot]?.[1];
      const ok =
        baseType === expected && BASE_TYPES[baseType]?.size === fieldSize;
      offsets[slot] = ok ? size : -1;
    }
    size += fieldSize;
  }
  if (hasDeveloperFields) {
    if (cursor + 1 > end) throw new InvalidFit();
    const devCount = view.getUint8(cursor++);
    if (cursor + devCount * 3 > end) throw new InvalidFit();
    for (let i = 0; i < devCount; i++, cursor += 3)
      size += view.getUint8(cursor + 1);
  }
  return { globalNum, littleEndian, size, offsets, end: cursor };
}

// Valeur d'un champ lu ; null s'il est absent, d'un type inattendu ou à sa valeur invalide FIT.
function readField(
  view: DataView,
  data: number,
  definition: MessageDefinition,
  wanted: Wanted,
  slot: number,
): number | null {
  const offset = definition.offsets?.[slot] ?? -1;
  if (offset < 0) return null;
  const at = data + offset;
  switch (wanted[slot]?.[1]) {
    case UINT16: {
      const value = view.getUint16(at, definition.littleEndian);
      return value === 0xffff ? null : value;
    }
    case UINT32: {
      const value = view.getUint32(at, definition.littleEndian);
      return value === 0xffffffff ? null : value;
    }
    default: {
      const value = view.getUint8(at); // enum et uint8
      return value === 0xff ? null : value;
    }
  }
}

// Heure de départ absolue : start_time, sinon timestamp (fin) − durée, sinon time_created.
function startTimeOf(
  session: Session,
  timeCreated: number | null,
): number | null {
  const absolute = (value: number | null) =>
    value !== null && value >= DATE_TIME_MIN ? value : null;
  const durationMs = session.elapsedMs ?? session.timerMs;
  const end = absolute(session.timestamp);
  const fromEnd =
    end !== null && durationMs !== null
      ? end - Math.round(durationMs / 1000)
      : null;
  return (
    absolute(session.startTime) ?? absolute(fromEnd) ?? absolute(timeCreated)
  );
}

function toSummary(
  session: Session,
  startTime: number,
  manufacturer: number | null,
): FitSummary {
  const elapsedMs = session.elapsedMs ?? session.timerMs ?? 0;
  const timerMs = session.timerMs ?? elapsedMs;
  return {
    startDate: new Date((FIT_EPOCH_S + startTime) * 1000)
      .toISOString()
      .replace(".000Z", "Z"),
    sport: session.sport,
    subSport: session.subSport,
    sportType: toSportType(session.sport, session.subSport),
    device:
      manufacturer === null
        ? null
        : (MANUFACTURERS.get(manufacturer) ?? String(manufacturer)),
    distanceM: (session.distanceCm ?? 0) / 100,
    movingTimeS: Math.round(timerMs / 1000),
    elapsedTimeS: Math.round(elapsedMs / 1000),
    elevationGainM: session.ascentM,
    averageHeartrate: session.avgHr,
    maxHeartrate: session.maxHr,
  };
}

// Conversion vers le vocabulaire Strava de RUN_TYPES (ADR 0005, « Stockage → Sport »).
function toSportType(
  sport: number | null,
  subSport: number | null,
): StravaSportType {
  switch (sport) {
    case SPORT_RUNNING:
      if (subSport === SUB_SPORT_TRAIL) return "TrailRun";
      if (
        subSport === SUB_SPORT_TREADMILL ||
        subSport === SUB_SPORT_VIRTUAL_ACTIVITY
      ) {
        return "VirtualRun";
      }
      return "Run";
    case SPORT_CYCLING:
      return "Ride";
    case SPORT_WALKING:
      return "Walk";
    case SPORT_HIKING:
      return "Hike";
    case SPORT_SWIMMING:
      return "Swim";
    default:
      return "Workout";
  }
}
