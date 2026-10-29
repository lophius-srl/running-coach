// Client Strava : échange du code OAuth, rafraîchissement transparent des tokens.
// Ne jamais journaliser les tokens.

const TOKEN_URL = "https://www.strava.com/oauth/token";
const DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";
const API_BASE_URL = "https://www.strava.com/api/v3";

// Marge avant expiration en dessous de laquelle on rafraîchit (tokens Strava valides 6 h).
const REFRESH_MARGIN_SECONDS = 5 * 60;

export type StravaCredentials = {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
};

export type StravaTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

export type AuthorizationResult = StravaTokens & { athlete: { id: number } };

export class StravaError extends Error {}

async function postToken(
  credentials: StravaCredentials,
  params: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: credentials.STRAVA_CLIENT_ID,
      client_secret: credentials.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!response.ok) {
    throw new StravaError(`Strava token endpoint: HTTP ${response.status}`);
  }
  return response.json();
}

function assertTokens(body: unknown): asserts body is StravaTokens {
  const tokens = body as Partial<StravaTokens> | null;
  if (
    typeof tokens?.access_token !== "string" ||
    typeof tokens.refresh_token !== "string" ||
    typeof tokens.expires_at !== "number"
  ) {
    throw new StravaError("Strava token endpoint: unexpected response");
  }
}

export async function exchangeCode(
  credentials: StravaCredentials,
  code: string,
): Promise<AuthorizationResult> {
  const body = await postToken(credentials, {
    code,
    grant_type: "authorization_code",
  });
  assertTokens(body);
  const athleteId = (body as { athlete?: { id?: unknown } }).athlete?.id;
  if (typeof athleteId !== "number") {
    throw new StravaError("Strava token endpoint: missing athlete id");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_at,
    athlete: { id: athleteId },
  };
}

// Révoque un accès accordé par erreur (ex. athlète non propriétaire). Best effort.
export async function deauthorize(accessToken: string): Promise<void> {
  try {
    await fetch(DEAUTHORIZE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Le token expirera de lui-même ; rien n'a été stocké.
  }
}

async function refreshTokens(
  credentials: StravaCredentials,
  refreshToken: string,
): Promise<StravaTokens> {
  const body = await postToken(credentials, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  assertTokens(body);
  return body;
}

export async function getValidAccessToken(
  db: D1Database,
  credentials: StravaCredentials,
  userId: number,
  now = Date.now(),
): Promise<string> {
  const stored = await db
    .prepare(
      "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE user_id = ?",
    )
    .bind(userId)
    .first<StravaTokens>();
  if (!stored) throw new StravaError("No Strava tokens for this user");

  if (stored.expires_at - Math.floor(now / 1000) > REFRESH_MARGIN_SECONDS) {
    return stored.access_token;
  }

  const fresh = await refreshTokens(credentials, stored.refresh_token);
  await db
    .prepare(
      "UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?",
    )
    .bind(fresh.access_token, fresh.refresh_token, fresh.expires_at, userId)
    .run();
  return fresh.access_token;
}

// Appel authentifié à l'API Strava (chemin relatif à /api/v3), token rafraîchi si besoin.
export async function stravaApiFetch(
  db: D1Database,
  credentials: StravaCredentials,
  userId: number,
  path: string,
): Promise<Response> {
  const accessToken = await getValidAccessToken(db, credentials, userId);
  return fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
