import { useEffect, useState } from "react";
import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import { GoalForm } from "./GoalForm";
import { RecentRuns } from "./RecentRuns";

type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "connected"; athleteId: number };

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

// Message de suivi (zone role="status") ; l'échec est affiché à part, en alerte.
function syncMessage(sync: SyncState): string {
  switch (sync.status) {
    case "running":
      return "Synchronisation en cours…";
    case "done":
      return `${sync.imported} course(s) des 7 derniers jours synchronisée(s).`;
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

function Loading({ label }: { label: string }) {
  return (
    <p className="card state loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

// Erreur annoncée aux lecteurs d'écran et signalée par un libellé, pas seulement par la couleur.
function Alert({ message }: { message: string }) {
  return (
    <p className="alert" role="alert">
      <span className="alert-label">Erreur :</span> {message}
    </p>
  );
}

// Bouton officiel du kit de marque Strava (https://developers.strava.com/guidelines/), non modifié.
function ConnectWithStrava() {
  return (
    <a className="strava-connect" href="/api/auth/strava">
      <img
        src="/strava/btn_strava_connect_with_orange.svg"
        width={237}
        height={48}
        alt="Connect with Strava"
      />
    </a>
  );
}

// Logo officiel « Powered by Strava », en noir sur thème clair et en blanc sur thème sombre.
function PoweredByStrava() {
  return (
    <picture>
      <source
        srcSet="/strava/api_logo_pwrdBy_strava_horiz_white.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img
        className="powered-by"
        src="/strava/api_logo_pwrdBy_strava_horiz_black.svg"
        width={365}
        height={37}
        alt="Powered by Strava"
      />
    </picture>
  );
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

  const syncing = sync.status === "running";

  return (
    <div className="layout">
      <header className="app-header">
        <h1 className="app-title">Running Coach</h1>
        {session.status === "connected" && (
          <button type="button" className="button" onClick={logout}>
            Se déconnecter
          </button>
        )}
      </header>
      <main>
        {session.status === "loading" && <Loading label="Chargement…" />}
        {session.status === "anonymous" && (
          <section className="card state">
            <p>
              Connecte ton compte Strava pour suivre tes courses de la semaine.
            </p>
            <p>
              <ConnectWithStrava />
            </p>
          </section>
        )}
        {session.status === "connected" && (
          <>
            <p className="muted">
              Connecté (athlète Strava n° {session.athleteId}).
            </p>
            <div className="toolbar">
              <button
                type="button"
                className="button button-primary"
                onClick={synchronize}
                disabled={syncing}
                aria-busy={syncing}
              >
                {syncing && <span className="spinner" aria-hidden="true" />}
                Synchroniser maintenant
              </button>
              <span className="muted" role="status">
                {syncMessage(sync)}
              </span>
            </div>
            {sync.status === "failed" && (
              <Alert message="Échec de la synchronisation, réessaie plus tard." />
            )}
            {activities.status === "loading" && (
              <Loading label="Chargement de tes courses…" />
            )}
            {activities.status === "loaded" && (
              <RecentRuns data={activities.data} />
            )}
            {activities.status === "failed" && (
              <Alert message="Impossible de charger tes courses récentes." />
            )}
            <GoalForm />
          </>
        )}
      </main>
      <footer className="app-footer">
        <PoweredByStrava />
      </footer>
    </div>
  );
}
