// Lecture de activities.csv (export de compte Strava), logique pure sans I/O (ADR 0004).
// Partagée par le navigateur (aperçu, lots) et le Worker (revalidation de chaque ligne reçue).
//
// HYPOTHÈSES sur le format, déduites du format anglais connu et NON vérifiées sur un vrai export :
// - en-têtes trouvés par nom normalisé (casse, accents, espaces ignorés), jamais par position ;
//   les alias français sont supposés ;
// - « Distance » apparaît deux fois : la 1re en km (« 10.02 », parfois « 10,02 »), la 2de en mètres
//   (« 10020.0 »). La dernière est préférée si elle est lisible et > 0, sinon la 1re × 1000.
//   Avec une seule colonne « Distance », elle est lue en km ;
// - « Moving Time » (s) est préféré ; « Elapsed Time » (s, aussi en double) sert de repli ;
// - « Activity Date » est en UTC, au format « Mar 14, 2021, 7:02:11 AM » ;
// - « Activity Type » est un libellé (« Run », « Trail Run », « Virtual Run »…).
// Seuls ces champs résumés sont extraits : description, notes, matériel… ne quittent pas le navigateur.

import { RUN_TYPES } from "./run-types";

export const IMPORT_BATCH_SIZE = 200;
export const MAX_NAME_LENGTH = 200;
// Allure plausible d'une course : entre 2 et 20 min/km.
const MIN_PACE_S_PER_KM = 120;
const MAX_PACE_S_PER_KM = 1200;
const MAX_ELEVATION_GAIN_M = 20000;
const MAX_HEARTRATE = 250;

export type ImportedRun = {
  id: number;
  startDate: string; // ISO 8601 UTC
  sportType: string;
  name: string;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number | null;
  averageHeartrate: number | null;
};

export type InvalidReason = "id" | "date" | "distance" | "duration" | "pace";

export type HistoryFile = {
  runs: ImportedRun[]; // triées par date, dédoublonnées par id (la dernière ligne gagne)
  otherSports: number;
  invalid: Record<InvalidReason, number>;
  firstDate: string | null;
  lastDate: string | null;
};

export type ReadResult =
  { ok: true; file: HistoryFile } | { ok: false; missingColumns: string[] };

// Parseur RFC 4180 : guillemets doublés, virgules et retours à la ligne dans un champ, CRLF ou LF, BOM.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') field += text[i++];
      else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      rows.push([...row, field]);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows;
}

// « Type d'activité » → « typedactivite » : casse, accents, espaces et ponctuation ignorés.
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const COLUMN_ALIASES = {
  id: ["Activity ID", "ID de l'activité"],
  date: ["Activity Date", "Date de l'activité"],
  name: ["Activity Name", "Nom de l'activité"],
  type: ["Activity Type", "Type d'activité"],
  distance: ["Distance"],
  movingTime: ["Moving Time", "Temps de déplacement", "Durée de déplacement"],
  elapsedTime: ["Elapsed Time", "Temps écoulé", "Durée écoulée"],
  elevationGain: ["Elevation Gain", "Dénivelé positif"],
  averageHeartrate: ["Average Heart Rate", "Fréquence cardiaque moyenne"],
} as const;

type Column = keyof typeof COLUMN_ALIASES;
type Columns = Record<Column, number[]>;

const REQUIRED: readonly Column[] = ["id", "date", "type", "distance"];

const RUN_TYPE_ALIASES = new Map<string, string>([
  ...[...RUN_TYPES].map((type): [string, string] => [
    normalizeLabel(type),
    type,
  ]),
  ["courseapied", "Run"],
  ["trail", "TrailRun"],
  ["coursevirtuelle", "VirtualRun"],
]);

// Toutes les positions de chaque colonne, dans l'ordre du fichier (certaines sont en double).
function findColumns(header: string[]): Columns {
  const labels = header.map(normalizeLabel);
  const positions = (aliases: readonly string[]) => {
    const wanted = aliases.map(normalizeLabel);
    return labels.flatMap((label, i) => (wanted.includes(label) ? [i] : []));
  };
  const entries = Object.entries(COLUMN_ALIASES).map(([column, aliases]) => [
    column,
    positions(aliases),
  ]);
  return Object.fromEntries(entries) as Columns;
}

function missingColumns(columns: Columns): string[] {
  const missing = REQUIRED.filter((column) => columns[column].length === 0);
  const hasTime =
    columns.movingTime.length > 0 || columns.elapsedTime.length > 0;
  return [
    ...missing.map((column) => COLUMN_ALIASES[column][0]),
    ...(hasTime ? [] : [COLUMN_ALIASES.movingTime[0]]),
  ];
}

// Nombre positif, « , » ou « . » comme séparateur décimal ; null si vide ou illisible.
export function parseDecimal(text: string | undefined): number | null {
  const value = text?.trim() ?? "";
  if (!/^\d+(?:[.,]\d+)?$/.test(value)) return null;
  return Number(value.replace(",", "."));
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const STRAVA_DATE =
  /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([ap]m)$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function utcIso(parts: number[]): string | null {
  const [year, month, day, hour, minute, second] = parts;
  if (minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  const sameDay =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day;
  return sameDay ? date.toISOString() : null;
}

// « Mar 14, 2021, 7:02:11 AM » (UTC) → « 2021-03-14T07:02:11.000Z » ; null si illisible ou impossible.
export function parseActivityDate(text: string | undefined): string | null {
  const match = STRAVA_DATE.exec(text?.trim() ?? "");
  if (!match) return null;
  const [, monthName, day, year, hour, minute, second, meridiem] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  const hour12 = Number(hour);
  if (month < 0 || hour12 < 1 || hour12 > 12) return null;
  const hour24 = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  return utcIso([Number(year), month, Number(day), hour24, +minute, +second]);
}

function isIsoUtc(value: string): boolean {
  return ISO_UTC.test(value) && new Date(value).toISOString() === value;
}

function isElevation(value: number | null): boolean {
  return value === null || (value >= 0 && value <= MAX_ELEVATION_GAIN_M);
}

function isHeartrate(value: number | null): boolean {
  return value === null || (value > 0 && value <= MAX_HEARTRATE);
}

// Contrôle commun au navigateur et au Worker : motif du rejet, ou null si la course est valide.
export function invalidReason(run: ImportedRun): InvalidReason | null {
  if (!Number.isSafeInteger(run.id) || run.id <= 0) return "id";
  if (!isIsoUtc(run.startDate)) return "date";
  if (!Number.isFinite(run.distanceM) || run.distanceM <= 0) return "distance";
  if (!Number.isSafeInteger(run.movingTimeS) || run.movingTimeS <= 0) {
    return "duration";
  }
  const pace = run.movingTimeS / (run.distanceM / 1000);
  if (pace < MIN_PACE_S_PER_KM || pace > MAX_PACE_S_PER_KM) return "pace";
  return null;
}

function truncateName(name: string): string {
  return [...name.trim()].slice(0, MAX_NAME_LENGTH).join("");
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// Revalidation côté Worker d'une ligne reçue (JSON non fiable) ; null si elle est refusée.
export function validateImportedRun(value: unknown): ImportedRun | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const elevationGainM = nullableNumber(row.elevationGainM ?? null);
  const averageHeartrate = nullableNumber(row.averageHeartrate ?? null);
  if (
    typeof row.id !== "number" ||
    typeof row.startDate !== "string" ||
    typeof row.sportType !== "string" ||
    !RUN_TYPES.has(row.sportType) ||
    typeof (row.name ?? "") !== "string" ||
    typeof row.distanceM !== "number" ||
    typeof row.movingTimeS !== "number" ||
    elevationGainM === undefined ||
    averageHeartrate === undefined ||
    !isElevation(elevationGainM) ||
    !isHeartrate(averageHeartrate)
  ) {
    return null;
  }
  const run: ImportedRun = {
    id: row.id,
    startDate: row.startDate,
    sportType: row.sportType,
    name: truncateName(String(row.name ?? "")),
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    elevationGainM,
    averageHeartrate,
  };
  return invalidReason(run) === null ? run : null;
}

function readDistanceM(row: string[], positions: number[]): number {
  const metres = parseDecimal(row[positions[positions.length - 1]]);
  if (positions.length > 1 && metres !== null && metres > 0) return metres;
  const km = parseDecimal(row[positions[0]]);
  return km === null ? Number.NaN : km * 1000;
}

function readSeconds(row: string[], positions: number[]): number {
  for (const position of positions) {
    const seconds = parseDecimal(row[position]);
    if (seconds !== null && seconds > 0) return Math.round(seconds);
  }
  return Number.NaN;
}

function readOptional(
  row: string[],
  positions: number[],
  isValid: (value: number) => boolean,
): number | null {
  const value = parseDecimal(row[positions[positions.length - 1]]);
  return value !== null && isValid(value) ? value : null;
}

function toRun(
  row: string[],
  columns: Columns,
  sportType: string,
): ImportedRun {
  const id = row[columns.id[0]]?.trim() ?? "";
  return {
    id: /^\d+$/.test(id) ? Number(id) : Number.NaN,
    startDate: parseActivityDate(row[columns.date[0]]) ?? "",
    sportType,
    name: truncateName(row[columns.name[0]] ?? ""),
    distanceM: readDistanceM(row, columns.distance),
    movingTimeS: readSeconds(row, [
      ...columns.movingTime,
      ...columns.elapsedTime,
    ]),
    elevationGainM: readOptional(row, columns.elevationGain, (v) =>
      isElevation(v),
    ),
    averageHeartrate: readOptional(row, columns.averageHeartrate, (v) =>
      isHeartrate(v),
    ),
  };
}

function isBlank(row: string[]): boolean {
  return row.length === 1 && row[0].trim() === "";
}

// Lit tout le fichier : courses valides, autres sports et lignes rejetées comptés par motif.
export function readActivitiesCsv(text: string): ReadResult {
  const [header = [], ...rows] = parseCsv(text);
  const columns = findColumns(header);
  const missing = missingColumns(columns);
  if (missing.length > 0) return { ok: false, missingColumns: missing };

  const runsById = new Map<number, ImportedRun>();
  const invalid: Record<InvalidReason, number> = {
    id: 0,
    date: 0,
    distance: 0,
    duration: 0,
    pace: 0,
  };
  let otherSports = 0;
  for (const row of rows) {
    if (isBlank(row)) continue;
    const type = normalizeLabel(row[columns.type[0]] ?? "");
    const sportType = RUN_TYPE_ALIASES.get(type);
    if (sportType === undefined) {
      otherSports++;
      continue;
    }
    const run = toRun(row, columns, sportType);
    const reason = invalidReason(run);
    if (reason === null) runsById.set(run.id, run);
    else invalid[reason]++;
  }
  const runs = [...runsById.values()].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
  return {
    ok: true,
    file: {
      runs,
      otherSports,
      invalid,
      firstDate: runs[0]?.startDate ?? null,
      lastDate: runs[runs.length - 1]?.startDate ?? null,
    },
  };
}

// Découpe en lots d'au plus `size` éléments, envoyés un par un au Worker.
export function toBatches<T>(
  items: readonly T[],
  size = IMPORT_BATCH_SIZE,
): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
