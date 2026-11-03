// Envoi d'un fichier FIT depuis l'onglet Import (ADR 0005), logique testée sans React. Le Worker
// lit le fichier et renvoie un `message` en français, affiché tel quel.

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

// Multipart avec la session (cookie envoyé d'office sur la même origine).
export async function uploadFit(file: File): Promise<FitUploadOutcome> {
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
