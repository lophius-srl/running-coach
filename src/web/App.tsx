import { useEffect, useState } from "react";

type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "connected"; athleteId: number };

// Couleur de marque Strava (consignes : https://developers.strava.com/guidelines/).
const STRAVA_ORANGE = "#FC5200";

async function fetchSession(): Promise<Session> {
  const response = await fetch("/api/me");
  if (!response.ok) return { status: "anonymous" };
  const { athleteId } = (await response.json()) as { athleteId: number };
  return { status: "connected", athleteId };
}

export function App() {
  const [session, setSession] = useState<Session>({ status: "loading" });

  useEffect(() => {
    fetchSession()
      .then(setSession)
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession({ status: "anonymous" });
  }

  return (
    <main>
      <h1>Running Coach</h1>
      {session.status === "anonymous" && (
        <a
          href="/api/auth/strava"
          style={{
            display: "inline-block",
            padding: "0.6em 1.2em",
            background: STRAVA_ORANGE,
            color: "#fff",
            fontWeight: 600,
            textDecoration: "none",
            borderRadius: 4,
          }}
        >
          Connect with Strava
        </a>
      )}
      {session.status === "connected" && (
        <p>
          Connecté (athlète Strava n° {session.athleteId}).{" "}
          <button type="button" onClick={logout}>
            Se déconnecter
          </button>
        </p>
      )}
    </main>
  );
}
