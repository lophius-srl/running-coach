// Envoi d'un fichier FIT depuis l'onglet Import (ADR 0005), logique testée sans React. Le Worker
// lit le fichier et renvoie un `message` en français, affiché tel quel.

import { FIXED_MESSAGES, MAX_FIT_BYTES } from "../worker/imports/messages";
import type {
  FitImportResponse,
  FitImportStatus,
  LoggedImportStatus,
} from "../worker/imports/types";

// `logged` : le serveur a journalisé l'envoi (watch_imports), la liste « Derniers imports » change.
export type FitUploadOutcome = {
  ok: boolean;
  logged: boolean;
  message: string;
};

const LOGGED_STATUSES: ReadonlySet<FitImportStatus> =
  new Set<LoggedImportStatus>([
    "imported",
    "duplicate",
    "not_fit",
    "invalid",
    "quota",
  ]);

const FALLBACK = "Envoi impossible. Vérifie ta connexion, puis réessaie.";

export function fitUploadOutcome(body: unknown): FitUploadOutcome {
  const response = body as Partial<FitImportResponse> | null;
  if (typeof response?.message !== "string" || !response.status) {
    return { ok: false, logged: false, message: FALLBACK };
  }
  const { status, message } = response;
  const ok = status === "imported" || status === "duplicate";
  return { ok, logged: LOGGED_STATUSES.has(status), message };
}

// Refus avant envoi d'un fichier que le serveur rejetterait en 413 (même message).
export function fitFileProblem(file: { size: number }): string | null {
  return file.size > MAX_FIT_BYTES ? FIXED_MESSAGES.too_large : null;
}

// Multipart avec la session (cookie envoyé d'office sur la même origine).
export async function uploadFit(file: File): Promise<FitUploadOutcome> {
  const problem = fitFileProblem(file);
  if (problem !== null) return { ok: false, logged: false, message: problem };
  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch("/api/imports/fit", {
      method: "POST",
      body: form,
    });
    return fitUploadOutcome(await response.json());
  } catch {
    return { ok: false, logged: false, message: FALLBACK };
  }
}
