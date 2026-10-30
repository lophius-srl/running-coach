import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

// Session sans état : cookie `__Host-session` = "<userId>.<expiration epoch s>", signé
// en HMAC-SHA256 avec SESSION_SECRET (hono/cookie, vérification via crypto.subtle.verify,
// donc à temps constant). L'expiration est vérifiée côté serveur, pas seulement par Max-Age.

const SESSION_COOKIE = "session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  prefix: "host",
} as const;

export async function startSession(
  c: Context,
  secret: string,
  userId: number,
  now = Date.now(),
): Promise<void> {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  await setSignedCookie(c, SESSION_COOKIE, `${userId}.${expiresAt}`, secret, {
    ...cookieOptions,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function readSession(
  c: Context,
  secret: string | undefined,
  now = Date.now(),
): Promise<number | null> {
  if (!secret) return null;
  const value = await getSignedCookie(c, secret, SESSION_COOKIE, "host");
  if (!value) return null;

  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  const [, userId, expiresAt] = match;
  if (Number(expiresAt) <= Math.floor(now / 1000)) return null;
  return Number(userId);
}

export function endSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
}
