// Jeton personnel (issue #66, ADR 0005) : GET / POST / DELETE /api/personal-token, session requise.
// Le jeton n'est renvoyé qu'une fois, à la génération ; ensuite seules ses dates sont lisibles.

import { Hono } from "hono";
import type { AppEnv } from "../env";
import { generateToken, tokenSha256 } from "./token";
import type { GeneratedPersonalToken, PersonalTokenStatus } from "./types";

// Regénérer remplace l'ancien jeton : nouvelle date de création, aucune utilisation.
const UPSERT = `
  INSERT INTO personal_tokens (user_id, token_sha256) VALUES (?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    token_sha256 = excluded.token_sha256,
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    last_used_at = NULL
  RETURNING created_at`;

export const personalTokenRoutes = new Hono<AppEnv>();

personalTokenRoutes.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT created_at, last_used_at FROM personal_tokens WHERE user_id = ?",
  )
    .bind(c.get("userId"))
    .first<{ created_at: string; last_used_at: string | null }>();
  return c.json<PersonalTokenStatus>({
    exists: row !== null,
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
  });
});

personalTokenRoutes.post("/", async (c) => {
  const token = generateToken();
  const row = await c.env.DB.prepare(UPSERT)
    .bind(c.get("userId"), await tokenSha256(token))
    .first<{ created_at: string }>();
  if (!row) throw new Error("personal token not stored");
  c.header("Cache-Control", "no-store");
  return c.json<GeneratedPersonalToken>(
    { token, createdAt: row.created_at },
    201,
  );
});

personalTokenRoutes.delete("/", async (c) => {
  await c.env.DB.prepare("DELETE FROM personal_tokens WHERE user_id = ?")
    .bind(c.get("userId"))
    .run();
  return c.body(null, 204);
});
