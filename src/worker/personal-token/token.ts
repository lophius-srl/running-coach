// Jeton personnel du Raccourci iOS (ADR 0005) : 32 octets aléatoires en base64url, préfixe « rc_ ».
// Seule son empreinte SHA-256 (hex) est stockée ; le jeton lui-même n'est jamais conservé.

const PREFIX = "rc_";
const TOKEN_BYTES = 32;
// 32 octets en base64url sans remplissage : 43 caractères.
const TOKEN_FORMAT = /^rc_[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateToken(): string {
  return (
    PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
  );
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

// Un jeton aléatoire de 256 bits n'a pas besoin d'un hachage lent (ADR 0005).
export async function tokenSha256(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
