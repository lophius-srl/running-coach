// Lecture du corps de POST /api/imports/fit (ADR 0005) : FIT brut ou multipart (champ `file`),
// borné en taille pendant la lecture, sans dépendance (formData() natif de workerd).

import { MAX_FIT_BYTES } from "./messages";

// Marge pour l'enveloppe multipart (frontières, en-têtes de partie) autour d'un FIT de 1,5 Mio.
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
const RAW_TYPES = ["", "application/octet-stream", "application/vnd.ant.fit"];
const MULTIPART = "multipart/form-data";

export type FitBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "single_file" };

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function isAcceptedContentType(contentType: string | undefined) {
  const type = mediaType(contentType);
  return type === MULTIPART || RAW_TYPES.includes(type);
}

export function maxBodyBytes(contentType: string | undefined): number {
  return mediaType(contentType) === MULTIPART
    ? MAX_FIT_BYTES + MULTIPART_OVERHEAD_BYTES
    : MAX_FIT_BYTES;
}

// Lit tout le flux, ou null dès que `max` octets sont dépassés (Content-Length absent ou faux).
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Exactement un fichier, dans le champ `file` ; null sinon (ou multipart mal formé).
async function singleFile(
  body: Uint8Array,
  contentType: string,
): Promise<Uint8Array | null> {
  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    return null;
  }
  const files = [...form.values()].filter((value) => typeof value !== "string");
  const file = form.get("file");
  if (files.length !== 1 || file === null || typeof file === "string") {
    return null;
  }
  return new Uint8Array(await file.arrayBuffer());
}

// Le type de contenu a déjà été vérifié par isAcceptedContentType.
export async function readFitBody(request: Request): Promise<FitBody> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const raw = await readCapped(request.body, maxBodyBytes(contentType));
  if (raw === null) return { ok: false, reason: "too_large" };
  if (mediaType(contentType) !== MULTIPART) return { ok: true, bytes: raw };

  const bytes = await singleFile(raw, contentType);
  if (bytes === null) return { ok: false, reason: "single_file" };
  if (bytes.byteLength > MAX_FIT_BYTES)
    return { ok: false, reason: "too_large" };
  return { ok: true, bytes };
}
