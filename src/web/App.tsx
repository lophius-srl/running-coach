import { useEffect, useState } from "react";
import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import { RecentRuns } from "./RecentRuns";

type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "connected"; athleteId: number };

// Couleur de marque Strava (consignes : https://developers.strava.com/guidelines/).
const STRAVA_ORANGE = "#FC5200";

type SyncState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; imported: number }
  | { status: "failed" };

async function requestSync(): Promise<SyncState> {
  const response = await fetch("/api/sync", { method: "POST" });
  if (!response.ok) return { status: "failed" };
  const { imported } = (await response.json()) as { imported: number };
  return { status: "done", imported };
}

function syncMessage(sync: SyncState): string {
  switch (sync.status) {
    case "running":
      return "Synchronisation en cours…";
    case "done":
      return `${sync.imported} course(s) des 7 derniers jours synchronisée(s).`;
    case "failed":
      return "Échec de la synchronisation, réessaie plus tard.";
    default:
      return "";
  }
}

type ActivitiesState =
  | { status: "loading" }
  | { status: "loaded"; data: RecentRunsData }
  | { status: "failed" };

async function fetchActivities(): Promise<ActivitiesState> {
  const response = await fetch("/api/activities");
  if (!response.ok) return { status: "failed" };
  return { status: "loaded", data: (await response.json()) as RecentRunsData };
}

async function loadActivities(): Promise<ActivitiesState> {
  return fetchActivities().catch((): ActivitiesState => ({ status: "failed" }));
}

async function fetchSession(): Promise<Session> {
  const response = await fetch("/api/me");
  if (!response.ok) return { status: "anonymous" };
  const { athleteId } = (await response.json()) as { athleteId: number };
  return { status: "connected", athleteId };
}

export function App() {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [activities, setActivities] = useState<ActivitiesState>({
    status: "loading",
  });

  useEffect(() => {
    fetchSession()
      .then(setSession)
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  useEffect(() => {
    if (session.status === "connected") loadActivities().then(setActivities);
  }, [session.status]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession({ status: "anonymous" });
    setActivities({ status: "loading" });
  }

  async function synchronize() {
    setSync({ status: "running" });
    const result = await requestSync().catch((): SyncState => ({
      status: "failed",
    }));
    setSync(result);
    if (result.status === "done") setActivities(await loadActivities());
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
      {session.status === "connected" && (
        <p>
          <button
            type="button"
            onClick={synchronize}
            disabled={sync.status === "running"}
          >
            Synchroniser maintenant
          </button>{" "}
          <span role="status">{syncMessage(sync)}</span>
        </p>
      )}
      {session.status === "connected" && activities.status === "loaded" && (
        <RecentRuns data={activities.data} />
      )}
      {session.status === "connected" && activities.status === "failed" && (
        <p role="alert">Impossible de charger tes courses récentes.</p>
      )}
    </main>
  );
}
