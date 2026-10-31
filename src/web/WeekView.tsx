import { useEffect, useState } from "react";
import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import { RouteLink } from "./AppNav";
import { formatPaceRange } from "./format";
import { MissingPaces, ZONES } from "./Paces";
import { RecentRuns } from "./RecentRuns";
import { Alert, Loading } from "./ui";
import type { GoalState } from "./useGoal";

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

const SUMMARY_HEADING_ID = "paces-summary-title";

// Résumé des allures (fourchettes seules) ; le détail est sur la vue « Objectif & allures ».
function PacesSummary({ goal }: { goal: GoalState }) {
  if (goal.status === "loading") return <Loading label="Chargement…" />;
  if (goal.status === "failed") {
    return <Alert message="Impossible de charger tes allures." />;
  }
  const { paces, basis } = goal.data;
  return (
    <div className="card paces">
      {paces ? (
        <dl className="pace-list">
          {ZONES.map(({ key, label }) => (
            <div key={key} className="pace-zone">
              <dt>{label}</dt>
              <dd>
                {formatPaceRange(paces[key].fastSPerKm, paces[key].slowSPerKm)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <MissingPaces basis={basis} />
      )}
      <p>
        <RouteLink view="goal" className="text-link action-link">
          {paces ? "Détail de mes allures" : "Mon objectif"}
        </RouteLink>
      </p>
    </div>
  );
}

type Props = {
  athleteId: number;
  goal: GoalState;
  onSynced: () => void; // de nouvelles courses peuvent changer les allures
};

export function WeekView({ athleteId, goal, onSynced }: Props) {
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [activities, setActivities] = useState<ActivitiesState>({
    status: "loading",
  });

  useEffect(() => {
    loadActivities().then(setActivities);
  }, []);

  async function synchronize() {
    setSync({ status: "running" });
    const result = await requestSync().catch((): SyncState => ({
      status: "failed",
    }));
    setSync(result);
    if (result.status !== "done") return;
    onSynced();
    setActivities(await loadActivities());
  }

  const syncing = sync.status === "running";

  return (
    <>
      <p className="muted">Connecté (athlète Strava n° {athleteId}).</p>
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
      <div className="view-grid view-grid-aside">
        <div>
          {activities.status === "loading" && (
            <Loading label="Chargement de tes courses…" />
          )}
          {activities.status === "loaded" && (
            <RecentRuns data={activities.data} />
          )}
          {activities.status === "failed" && (
            <Alert message="Impossible de charger tes courses récentes." />
          )}
        </div>
        <section aria-labelledby={SUMMARY_HEADING_ID}>
          <h2 id={SUMMARY_HEADING_ID} className="section-title">
            Mes allures
          </h2>
          <PacesSummary goal={goal} />
        </section>
      </div>
    </>
  );
}
