import { useEffect, useRef, useState } from "react";
import { AppNav } from "./AppNav";
import { GoalView } from "./GoalView";
import { HistoryImport } from "./HistoryImport";
import { Layout } from "./Layout";
import { APP_NAME, documentTitle, routeFor } from "./routes";
import { ConnectWithStrava, Loading } from "./ui";
import { useGoal } from "./useGoal";
import { useRoute } from "./useRoute";
import { useSync } from "./useSync";
import { WeekView } from "./WeekView";

type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "connected"; athleteId: number };

async function fetchSession(): Promise<Session> {
  const response = await fetch("/api/me");
  if (!response.ok) return { status: "anonymous" };
  const { athleteId } = (await response.json()) as { athleteId: number };
  return { status: "connected", athleteId };
}

type ConnectedProps = { athleteId: number; onLogout: () => void };

// App connectée : trois vues, une URL chacune (voir routes.ts). Démontée à la déconnexion,
// ce qui remet tout son état à zéro.
function ConnectedApp({ athleteId, onLogout }: ConnectedProps) {
  const view = useRoute();
  const goal = useGoal(view);
  const sync = useSync(goal.refresh);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownView = useRef(view);

  // Après une navigation (pas au premier affichage), le focus va au titre de la vue : les
  // lecteurs d'écran l'annoncent et la tabulation repart du début du contenu.
  useEffect(() => {
    document.title = documentTitle(view);
    if (shownView.current === view) return;
    shownView.current = view;
    titleRef.current?.focus();
  }, [view]);

  useEffect(
    () => () => {
      document.title = APP_NAME;
    },
    [],
  );

  return (
    <Layout
      nav={<AppNav current={view} />}
      actions={
        <button type="button" className="button" onClick={onLogout}>
          Se déconnecter
        </button>
      }
    >
      <h1 ref={titleRef} tabIndex={-1} className="view-title">
        {routeFor(view).label}
      </h1>
      {view === "week" && (
        <WeekView
          athleteId={athleteId}
          goal={goal.state}
          sync={sync.state}
          syncCount={sync.syncCount}
          onSync={sync.synchronize}
        />
      )}
      {view === "goal" && (
        <GoalView
          goal={goal.state}
          onRetry={goal.retry}
          onSaved={goal.replace}
        />
      )}
      {view === "history" && <HistoryImport />}
    </Layout>
  );
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

  if (session.status === "connected") {
    return <ConnectedApp athleteId={session.athleteId} onLogout={logout} />;
  }

  return (
    <Layout>
      {session.status === "loading" ? (
        <Loading label="Chargement…" />
      ) : (
        <section className="card state">
          <p>
            Connecte ton compte Strava pour suivre tes courses de la semaine.
          </p>
          <p>
            <ConnectWithStrava />
          </p>
        </section>
      )}
    </Layout>
  );
}
