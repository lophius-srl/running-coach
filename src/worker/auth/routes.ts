import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { deauthorize, exchangeCode, StravaError } from "../strava/client";
import { endSession, startSession } from "./session";

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
// read : profil public (athlete.id). activity:read_all : activités, y compris privées
// (« Only Me »), nécessaires à la synchro et au coaching des issues suivantes.
export const STRAVA_SCOPE = "read,activity:read_all";

const STATE_COOKIE = "oauth_state";
const CALLBACK_PATH = "/api/auth/strava/callback";
const stateCookieOptions = {
  path: CALLBACK_PATH,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

// Fail closed : sans OWNER_ATHLETE_ID valide, aucune connexion n'est possible.
function ownerAthleteId(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : null;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const NOT_CONFIGURED = "Connexion désactivée : OWNER_ATHLETE_ID non configuré.";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/strava", (c) => {
  if (ownerAthleteId(c.env.OWNER_ATHLETE_ID) === null) {
    return c.text(NOT_CONFIGURED, 403);
  }
  const state = randomState();
  setCookie(c, STATE_COOKIE, state, { ...stateCookieOptions, maxAge: 600 });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: c.env.STRAVA_CLIENT_ID,
    redirect_uri: new URL(CALLBACK_PATH, c.req.url).toString(),
    response_type: "code",
    approval_prompt: "auto",
    scope: STRAVA_SCOPE,
    state,
  }).toString();
  return c.redirect(url.toString(), 302);
});

authRoutes.get("/strava/callback", async (c) => {
  const expectedState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, stateCookieOptions);
  const { state, code, scope, error } = c.req.query();

  if (!expectedState || !state || state !== expectedState) {
    return c.text("Paramètre state invalide.", 400);
  }
  if (error) return c.redirect("/", 302);
  if (!code) return c.text("Code d'autorisation manquant.", 400);

  const ownerId = ownerAthleteId(c.env.OWNER_ATHLETE_ID);
  if (ownerId === null) return c.text(NOT_CONFIGURED, 403);

  let authorization;
  try {
    authorization = await exchangeCode(c.env, code);
  } catch (err) {
    if (err instanceof StravaError) {
      return c.text("Échec de l'échange avec Strava.", 502);
    }
    throw err;
  }

  if (authorization.athlete.id !== ownerId) {
    await deauthorize(authorization.access_token);
    return c.text("Accès réservé au propriétaire de l'application.", 403);
  }

  const db = c.env.DB;
  const [, , selected] = await db.batch<{ id: number }>([
    db
      .prepare(
        "INSERT INTO users (strava_athlete_id) VALUES (?) ON CONFLICT (strava_athlete_id) DO NOTHING",
      )
      .bind(ownerId),
    db
      .prepare(
        `INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope)
         SELECT id, ?, ?, ?, ? FROM users WHERE strava_athlete_id = ?
         ON CONFLICT (user_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(
        authorization.access_token,
        authorization.refresh_token,
        authorization.expires_at,
        scope ?? "",
        ownerId,
      ),
    db
      .prepare("SELECT id FROM users WHERE strava_athlete_id = ?")
      .bind(ownerId),
  ]);

  await startSession(c, c.env.SESSION_SECRET, selected.results[0].id);
  return c.redirect("/", 302);
});

// Supprime uniquement le cookie de session : les tokens restent en base pour la synchro.
authRoutes.post("/logout", (c) => {
  endSession(c);
  return c.body(null, 204);
});
