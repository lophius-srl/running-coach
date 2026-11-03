// Décodeur FIT minimal (ADR 0005, issue #67) : lit le résumé d'une séance, sans I/O ni dépendance.
// Ne décode que file_id (0), sport (12) et session (18) ; tout autre message (dont les milliers de
// `record`) est sauté grâce à la taille donnée par sa définition, sans allocation.
//
// Sources (consultées le 2026-11-03) :
// - Protocole FIT : https://developer.garmin.com/fit/protocol/ (en-tête de fichier 12 ou 14 octets,
//   signature ".FIT", en-têtes d'enregistrement normal / à horodatage compressé, définitions).
// - SDK FIT JavaScript officiel de Garmin, @garmin/fitsdk 21.218.0 (archive npm, Profile 21.218.0) :
//   decoder.js (masques 0x80 / 0x40 / 0x20 / 0x0F, architecture 0 = little endian, CRC d'en-tête
//   ignoré s'il vaut 0, CRC de fichier sur en-tête + données), crc-calculator.js (table CRC-16),
//   fit.js (types de base et valeurs invalides), utils.js (époque FIT 631065600 s = 1989-12-31Z),
//   profile.js (numéros de messages et de champs, échelles, énumérations sport / sub_sport /
//   manufacturer).

export type StravaSportType =
  | "Run"
  | "TrailRun"
  | "VirtualRun"
  | "Ride"
  | "Walk"
  | "Hike"
  | "Swim"
  | "Workout";

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
const CRC_SIZE = 2;

const MESG_FILE_ID = 0;
const MESG_SPORT = 12;
const MESG_SESSION = 18;

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
  [129, "coros"],
  [260, "zwift"],
]);

// Types de base entiers non signés lus par le décodeur : taille et valeur invalide (fit.js).
const UNSIGNED_BASE_TYPES: ReadonlyMap<
  number,
  { size: number; invalid: number }
> = new Map([
  [0x00, { size: 1, invalid: 0xff }], // enum
  [0x02, { size: 1, invalid: 0xff }], // uint8
  [0x04, { size: 2, invalid: 0xffff }], // uint16
  [0x06, { size: 4, invalid: 0xffffffff }], // uint32
  [0x0a, { size: 1, invalid: 0 }], // uint8z
  [0x0b, { size: 2, invalid: 0 }], // uint16z
  [0x0c, { size: 4, invalid: 0 }], // uint32z
]);

type FieldDefinition = {
  num: number;
  offset: number;
  size: number;
  baseType: number;
};

type MessageDefinition = {
  globalNum: number;
  littleEndian: boolean;
  size: number; // champs normaux + champs développeur
  fields: FieldDefinition[]; // vide pour les messages sautés
};

type Session = {
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

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

// CRC-16 FIT (crc-calculator.js du SDK), calculé quartet par quartet.
export function fitCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i] ?? 0;
    let tmp = CRC_TABLE[crc & 0xf] ?? 0;
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ (CRC_TABLE[byte & 0xf] ?? 0);
    tmp = CRC_TABLE[crc & 0xf] ?? 0;
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ (CRC_TABLE[(byte >> 4) & 0xf] ?? 0);
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

function readRecords(
  view: DataView,
  start: number,
  end: number,
  scan: FitScan,
): FitResult {
  const definitions: (MessageDefinition | undefined)[] = new Array(16);
  let manufacturer: number | null = null;
  let timeCreated: number | null = null;
  let lastSport: number | null = null;
  let lastSubSport: number | null = null;
  let firstSession: Session | null = null;
  let firstRunSession: Session | null = null;
  let pos = start;
  while (pos < end) {
    const header = byteAt(view, pos, end);
    if ((header & 0x40) !== 0 && (header & 0x80) === 0) {
      const local = header & 0x0f;
      [definitions[local], pos] = readDefinition(
        view,
        pos,
        end,
        (header & 0x20) !== 0,
      );
      continue;
    }
    // Horodatage compressé : bit 7, type local sur les bits 5–6 (0 à 3), décalage sur les bits 0–4.
    const local = (header & 0x80) !== 0 ? (header >> 5) & 0x03 : header & 0x0f;
    const definition = definitions[local];
    if (definition === undefined || pos + 1 + definition.size > end)
      throw new InvalidFit();
    const data = pos + 1;
    pos = data + definition.size;
    if (definition.fields.length === 0) {
      scan.skippedMessages++;
      continue;
    }
    scan.decodedMessages++;
    const read = (num: number) => readUnsigned(view, data, definition, num);
    if (definition.globalNum === MESG_FILE_ID) {
      manufacturer = read(1);
      timeCreated = read(4);
    } else if (definition.globalNum === MESG_SPORT) {
      lastSport = read(0);
      lastSubSport = read(1);
    } else {
      const session: Session = {
        startTime: read(2),
        sport: read(5) ?? lastSport,
        subSport: read(6) ?? lastSubSport,
        elapsedMs: read(7),
        timerMs: read(8),
        distanceCm: read(9),
        ascentM: read(22),
        avgHr: read(16),
        maxHr: read(17),
      };
      firstSession ??= session;
      if (session.sport === SPORT_RUNNING) firstRunSession ??= session;
    }
  }
  const session = firstRunSession ?? firstSession;
  if (session === null) return fail("no_session");
  const startTime = session.startTime ?? timeCreated;
  if (startTime === null) return fail("invalid");
  return { ok: true, summary: toSummary(session, startTime, manufacturer) };
}

function byteAt(view: DataView, pos: number, end: number): number {
  if (pos >= end) throw new InvalidFit();
  return view.getUint8(pos);
}

function readDefinition(
  view: DataView,
  pos: number,
  end: number,
  hasDeveloperFields: boolean,
): [MessageDefinition, number] {
  if (pos + 6 > end) throw new InvalidFit();
  const littleEndian = view.getUint8(pos + 2) === 0;
  const globalNum = view.getUint16(pos + 3, littleEndian);
  const fieldCount = view.getUint8(pos + 5);
  const decoded =
    globalNum === MESG_FILE_ID ||
    globalNum === MESG_SPORT ||
    globalNum === MESG_SESSION;
  const fields: FieldDefinition[] = [];
  let size = 0;
  let cursor = pos + 6;
  if (cursor + fieldCount * 3 > end) throw new InvalidFit();
  for (let i = 0; i < fieldCount; i++, cursor += 3) {
    const fieldSize = view.getUint8(cursor + 1);
    if (decoded) {
      const baseType = view.getUint8(cursor + 2) & 0x1f;
      fields.push({
        num: view.getUint8(cursor),
        offset: size,
        size: fieldSize,
        baseType,
      });
    }
    size += fieldSize;
  }
  if (hasDeveloperFields) {
    const devCount = byteAt(view, cursor, end);
    cursor++;
    if (cursor + devCount * 3 > end) throw new InvalidFit();
    for (let i = 0; i < devCount; i++, cursor += 3)
      size += view.getUint8(cursor + 1);
  }
  return [{ globalNum, littleEndian, size, fields }, cursor];
}

// Valeur d'un champ entier non signé ; null si absent, de type inattendu ou invalide (FIT).
function readUnsigned(
  view: DataView,
  data: number,
  definition: MessageDefinition,
  num: number,
): number | null {
  const field = definition.fields.find((candidate) => candidate.num === num);
  const baseType = field && UNSIGNED_BASE_TYPES.get(field.baseType);
  if (!field || !baseType || baseType.size !== field.size) return null;
  const at = data + field.offset;
  const le = definition.littleEndian;
  const value =
    field.size === 1
      ? view.getUint8(at)
      : field.size === 2
        ? view.getUint16(at, le)
        : view.getUint32(at, le);
  return value === baseType.invalid ? null : value;
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
export function toSportType(
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
