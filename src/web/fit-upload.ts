// Envoi d'un fichier FIT depuis l'onglet Import (ADR 0005), logique testée sans React. Le Worker
// lit le fichier et renvoie un `message` en français, affiché tel quel.

import { FIXED_MESSAGES, MAX_FIT_BYTES } from "../worker/imports/messages";
import type { FitImportResponse } from "../worker/imports/types";

export type FitUploadOutcome = { ok: boolean; message: string };

const FALLBACK = "Envoi impossible. Vérifie ta connexion, puis réessaie.";

export function fitUploadOutcome(body: unknown): FitUploadOutcome {
  const response = body as Partial<FitImportResponse> | null;
  if (typeof response?.message !== "string" || !response.status) {
    return { ok: false, message: FALLBACK };
  }
  const ok = response.status === "imported" || response.status === "duplicate";
  return { ok, message: response.message };
}

// Refus avant envoi d'un fichier que le serveur rejetterait en 413 (même message).
export function fitFileProblem(file: { size: number }): string | null {
  return file.size > MAX_FIT_BYTES ? FIXED_MESSAGES.too_large : null;
}

// Multipart avec la session (cookie envoyé d'office sur la même origine).
export async function uploadFit(file: File): Promise<FitUploadOutcome> {
  const problem = fitFileProblem(file);
  if (problem !== null) return { ok: false, message: problem };
  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch("/api/imports/fit", {
      method: "POST",
      body: form,
    });
    return fitUploadOutcome(await response.json());
  } catch {
    return { ok: false, message: FALLBACK };
  }
}
