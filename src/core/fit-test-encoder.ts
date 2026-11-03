// Encodeur FIT minimal, réservé aux tests de fit.ts : produit des fichiers synthétiques valides
// (CRC calculés) pour couvrir endianness, en-têtes 12/14 octets, horodatage compressé et champs
// développeur. Importé uniquement par fit.test.ts.
import { fitCrc } from "./fit";

export type FitBaseType =
  "enum" | "uint8" | "uint16" | "uint32" | "uint32z" | "byte";

export type FitFieldSpec = {
  num: number;
  type: FitBaseType;
  value: number | null; // null → valeur invalide du type
  size?: number; // octets, pour "byte" seulement (défaut 1)
};

export type FitMessageSpec = {
  global: number;
  fields: FitFieldSpec[];
  local?: number; // 0–15 (0–3 en horodatage compressé), défaut 0
  bigEndian?: boolean;
  developerFields?: { num: number; size: number; index: number }[];
  compressedTimeOffset?: number; // 0–31 : en-tête à horodatage compressé
};

export type FitFileOptions = {
  headerSize?: 12 | 14; // défaut 14
  headerCrc?: boolean; // défaut true ; false → CRC d'en-tête à 0
};

const BASE_TYPES: Record<
  FitBaseType,
  { id: number; size: number; invalid: number }
> = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
  byte: { id: 0x0d, size: 1, invalid: 0xff },
};

export const FIT_EPOCH_S = 631065600;

export function fitTime(iso: string): number {
  return Date.parse(iso) / 1000 - FIT_EPOCH_S;
}

export function encodeFit(
  messages: FitMessageSpec[],
  options: FitFileOptions = {},
): Uint8Array {
  const data: number[] = [];
  const lastDefinition = new Map<number, string>();
  for (const message of messages) {
    const local = message.local ?? 0;
    const definition = encodeDefinition(message, local);
    const key = definition.join(",");
    if (lastDefinition.get(local) !== key) {
      data.push(...definition);
      lastDefinition.set(local, key);
    }
    const offset = message.compressedTimeOffset;
    data.push(
      offset === undefined ? local : 0x80 | (local << 5) | (offset & 0x1f),
    );
    for (const field of message.fields) {
      data.push(...encodeValue(field, message.bigEndian ?? false));
    }
    for (const devField of message.developerFields ?? []) {
      data.push(...new Array<number>(devField.size).fill(0xab));
    }
  }
  return wrapFitData(data, options);
}

function encodeDefinition(message: FitMessageSpec, local: number): number[] {
  const devFields = message.developerFields ?? [];
  const header = 0x40 | (devFields.length > 0 ? 0x20 : 0) | local;
  const bigEndian = message.bigEndian ?? false;
  const global = bigEndian
    ? [message.global >> 8, message.global & 0xff]
    : [message.global & 0xff, message.global >> 8];
  const bytes = [
    header,
    0,
    bigEndian ? 1 : 0,
    ...global,
    message.fields.length,
  ];
  for (const field of message.fields) {
    const base = BASE_TYPES[field.type];
    bytes.push(field.num, field.size ?? base.size, base.id);
  }
  if (devFields.length > 0) {
    bytes.push(devFields.length);
    for (const devField of devFields)
      bytes.push(devField.num, devField.size, devField.index);
  }
  return bytes;
}

function encodeValue(field: FitFieldSpec, bigEndian: boolean): number[] {
  const base = BASE_TYPES[field.type];
  const size = field.size ?? base.size;
  const value = field.value ?? base.invalid;
  const bytes: number[] = [];
  for (let i = 0; i < size; i++)
    bytes.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  return bigEndian ? bytes.reverse() : bytes;
}

// Enveloppe des octets de données bruts dans un fichier FIT (en-tête et CRC calculés).
export function wrapFitData(
  data: number[],
  options: FitFileOptions = {},
): Uint8Array {
  const headerSize = options.headerSize ?? 14;
  const file = new Uint8Array(headerSize + data.length + 2);
  const view = new DataView(file.buffer);
  file[0] = headerSize;
  file[1] = 0x20; // protocole 2.0
  view.setUint16(2, 21218, true); // profil 21.218
  view.setUint32(4, data.length, true);
  file.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  if (headerSize === 14 && options.headerCrc !== false) {
    view.setUint16(12, fitCrc(file, 0, 12), true);
  }
  file.set(data, headerSize);
  const end = headerSize + data.length;
  view.setUint16(end, fitCrc(file, 0, end), true);
  return file;
}
