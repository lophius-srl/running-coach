// Import de l'historique (ADR 0004), logique non visuelle testée sans React : contrôle du fichier,
// aperçu, charge utile restreinte aux champs résumés et envoi séquentiel des lots avec reprise.

import {
  toBatches,
  type HistoryFile,
  type ImportedRun,
  type ReadError,
} from "../core/history-csv";

// activities.csv pèse quelques Mo ; au-delà, ce n'est pas le bon fichier (archive, GPX…).
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Refus avant lecture : archive non extraite ou fichier démesuré. null si le fichier peut être lu.
export function fileProblem(file: {
  name: string;
  size: number;
}): string | null {
  if (/\.zip$/i.test(file.name)) {
    return "C'est l'archive .zip : extrais-en le fichier activities.csv, puis dépose ce fichier.";
  }
  if (file.size > MAX_FILE_BYTES) {
    return "Ce fichier est trop gros pour être activities.csv (50 Mo au plus).";
  }
  return null;
}

export function readErrorMessage(error: ReadError): string {
  switch (error.reason) {
    case "missingColumns":
      return (
        `Ce fichier n'est pas un activities.csv lisible : colonnes absentes (${error.missingColumns.join(", ")}). ` +
        "Si ton export est dans une autre langue, passe Strava en anglais puis refais l'export."
      );
    case "malformed":
      return "Ce fichier n'est pas un CSV valide (tronqué ou corrompu). Refais l'export Strava.";
    case "dateFormat":
      return "Les dates de ce fichier sont illisibles. Passe Strava en anglais puis refais l'export.";
  }
}

export type Preview = {
  runs: number;
  firstDate: string | null;
  lastDate: string | null;
  ignored: number;
  otherSports: number;
  invalid: number;
  duplicates: number;
};

export function previewOf(file: HistoryFile): Preview {
  const invalid = Object.values(file.invalid).reduce((a, b) => a + b, 0);
  return {
    runs: file.runs.length,
    firstDate: file.firstDate,
    lastDate: file.lastDate,
    ignored: file.otherSports + invalid + file.duplicates,
    otherSports: file.otherSports,
    invalid,
    duplicates: file.duplicates,
  };
}

// Liste blanche explicite des champs envoyés : rien d'autre ne quitte le navigateur.
export function toPayload(run: ImportedRun): ImportedRun {
  return {
    id: run.id,
    startDate: run.startDate,
    sportType: run.sportType,
    name: run.name,
    distanceM: run.distanceM,
    movingTimeS: run.movingTimeS,
    elevationGainM: run.elevationGainM,
    averageHeartrate: run.averageHeartrate,
  };
}

export function payloadBatches(runs: readonly ImportedRun[]): ImportedRun[][] {
  return toBatches(runs.map(toPayload));
}

export type BatchResult = { inserted: number; alreadyPresent: number };

export type SendBatch = (rows: ImportedRun[]) => Promise<BatchResult>;

// Avancement de l'import : le prochain lot à envoyer et les totaux déjà confirmés par le Worker.
export type Progress = {
  nextBatch: number;
  totalBatches: number;
  inserted: number;
  alreadyPresent: number;
};

export function startProgress(totalBatches: number): Progress {
  return { nextBatch: 0, totalBatches, inserted: 0, alreadyPresent: 0 };
}

export type SendOutcome =
  | { ok: true; progress: Progress }
  | { ok: false; progress: Progress; error: unknown };

// Envoie les lots un par un à partir de `progress.nextBatch`. Sur erreur, rend l'avancement
// atteint : relancer avec lui reprend au lot en échec (le dédoublonnage serveur évite les doublons).
export async function sendBatches(
  batches: readonly ImportedRun[][],
  progress: Progress,
  send: SendBatch,
  onProgress: (progress: Progress) => void,
): Promise<SendOutcome> {
  let current = progress;
  while (current.nextBatch < batches.length) {
    try {
      const result = await send(batches[current.nextBatch]);
      current = {
        ...current,
        nextBatch: current.nextBatch + 1,
        inserted: current.inserted + result.inserted,
        alreadyPresent: current.alreadyPresent + result.alreadyPresent,
      };
    } catch (error) {
      return { ok: false, progress: current, error };
    }
    onProgress(current);
  }
  return { ok: true, progress: current };
}

export class ImportRequestError extends Error {
  constructor(readonly status: number) {
    super(`import failed: ${status}`);
  }
}

export function sendErrorMessage(error: unknown): string {
  if (error instanceof ImportRequestError && error.status === 401) {
    return "Ta session a expiré : reconnecte-toi, puis relance l'import.";
  }
  return "L'envoi d'un lot a échoué (connexion ou serveur). Relance l'import : il reprendra là où il s'est arrêté, sans doublon.";
}

export const postBatch: SendBatch = async (rows) => {
  const response = await fetch("/api/history/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  if (!response.ok) throw new ImportRequestError(response.status);
  return (await response.json()) as BatchResult;
};
