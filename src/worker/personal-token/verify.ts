// Authentification par jeton personnel (`Authorization: Bearer rc_…`), pour l'import FIT (#68).
// La recherche se fait par empreinte : le jeton reçu n'est jamais comparé en clair.

import { isWellFormedToken, tokenSha256 } from "./token";

const BEARER = /^Bearer +(\S+)$/i;

const TOUCH = `
  UPDATE personal_tokens
  SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE token_sha256 = ?
  RETURNING user_id`;

// Utilisateur propriétaire du jeton, ou null (en-tête absent, mal formé, jeton inconnu ou révoqué).
// Met à jour last_used_at du jeton reconnu.
export async function userIdForBearer(
  db: D1Database,
  authorizationHeader: string | null | undefined,
): Promise<number | null> {
  const token = BEARER.exec(authorizationHeader ?? "")?.[1];
  if (token === undefined || !isWellFormedToken(token)) return null;
  const row = await db
    .prepare(TOUCH)
    .bind(await tokenSha256(token))
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}
