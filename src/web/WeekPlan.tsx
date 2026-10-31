import { useEffect, useState } from "react";
import { HARD_KINDS } from "../core/plan";
import type { PlanResponse, PlanView } from "../worker/plans/view";
import { RouteLink } from "./AppNav";
import { formatPaceRange, localIsoDate } from "./format";
import {
  formatPlanDay,
  formatPlanPeriod,
  formatSessionDuration,
  isPlanOver,
  PHASE_LABELS,
  planErrorMessage,
  replacedKindLabel,
  SESSION_LABELS,
} from "./plan";
import { Alert, Loading } from "./ui";
import type { GoalState } from "./useGoal";

const HEADING_ID = "week-plan-title";

type PlanState =
  | { status: "loading" }
  | { status: "loaded"; plan: PlanView | null }
  | { status: "failed" };

async function loadPlan(): Promise<PlanState> {
  try {
    const response = await fetch("/api/plan");
    if (!response.ok) return { status: "failed" };
    const { plan } = (await response.json()) as PlanResponse;
    return { status: "loaded", plan };
  } catch {
    return { status: "failed" };
  }
}

// Plan sauvegardé, ou message d'erreur de génération.
async function requestPlan(): Promise<PlanView | string> {
  try {
    const response = await fetch("/api/plan", { method: "POST" });
    const body = (await response.json()) as Partial<PlanResponse> & {
      error?: unknown;
    };
    return response.ok && body.plan ? body.plan : planErrorMessage(body.error);
  } catch {
    return planErrorMessage(null);
  }
}

// Ce qui manque pour générer un plan, ou null si tout est prêt.
function MissingInputs({ goal }: { goal: GoalState }) {
  if (goal.status !== "loaded") return null;
  if (!goal.data.goal) {
    return (
      <p className="muted">
        Enregistre ton{" "}
        <RouteLink view="goal" className="text-link">
          objectif
        </RouteLink>{" "}
        pour recevoir ton plan.
      </p>
    );
  }
  if (goal.data.goal.availableDays.length === 0) {
    return (
      <p className="muted">
        Coche tes jours disponibles dans ton{" "}
        <RouteLink view="goal" className="text-link">
          objectif
        </RouteLink>{" "}
        pour recevoir ton plan.
      </p>
    );
  }
  if (goal.data.paces) return null;
  return (
    <p className="muted">
      Il faut d'abord tes allures : synchronise tes courses ou importe ton{" "}
      <RouteLink view="history" className="text-link">
        historique
      </RouteLink>
      .
    </p>
  );
}

function PlanSessions({ plan }: { plan: PlanView }) {
  if (plan.sessions.length === 0) {
    return (
      <p className="card state">
        Aucune séance d'ici la course : repos, et bonne course !
      </p>
    );
  }
  return (
    <ol className="plan-list">
      {plan.sessions.map((session) => {
        const hard = HARD_KINDS.has(session.kind);
        const pace = session.targetPace;
        const replaced = replacedKindLabel(session);
        return (
          <li
            key={session.date}
            className={`card plan-session${hard ? " plan-session-hard" : ""}`}
          >
            <p className="muted plan-day">
              <time dateTime={session.date}>{formatPlanDay(session.date)}</time>
            </p>
            <h3 className="plan-kind">
              {SESSION_LABELS[session.kind]}
              {hard && <span className="plan-tag">Séance dure</span>}
              {replaced && (
                <span className="muted plan-replaced">{replaced}</span>
              )}
            </h3>
            <dl className="run-stats plan-stats">
              <div>
                <dt>Durée</dt>
                <dd>{formatSessionDuration(session)}</dd>
              </div>
              <div>
                <dt>Allure cible</dt>
                <dd>
                  {pace
                    ? formatPaceRange(pace.fastSPerKm, pace.slowSPerKm)
                    : "–"}
                </dd>
              </div>
            </dl>
            <p>{session.description}</p>
          </li>
        );
      })}
    </ol>
  );
}

type Props = {
  goal: GoalState;
  syncCount: number; // change à chaque sync réussie : les allures cibles sont relues
};

// Clé de l'objectif enregistré : le plan est relu quand il change (allures, jours) ;
// undefined tant que l'objectif charge, pour ne pas lire le plan deux fois au démarrage.
function goalKey(goal: GoalState): string | undefined {
  if (goal.status === "loading") return undefined;
  return goal.status === "loaded" ? JSON.stringify(goal.data) : "failed";
}

// Plan de la semaine : dernier plan enregistré, et bouton pour en générer un nouveau.
export function WeekPlan({ goal, syncCount }: Props) {
  const [state, setState] = useState<PlanState>({ status: "loading" });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planKey = goalKey(goal);

  useEffect(() => {
    if (planKey === undefined) return;
    let active = true;
    loadPlan().then((loaded) => {
      if (active) setState(loaded);
    });
    return () => {
      active = false;
    };
  }, [syncCount, planKey]);

  async function generate() {
    setGenerating(true);
    setError(null);
    const result = await requestPlan();
    setGenerating(false);
    if (typeof result === "string") setError(result);
    else setState({ status: "loaded", plan: result });
  }

  const ready =
    goal.status === "loaded" &&
    !!goal.data.goal?.availableDays.length &&
    !!goal.data.paces;
  const plan = state.status === "loaded" ? state.plan : null;
  const over = !!plan && isPlanOver(plan.weekStart, localIsoDate(new Date()));
  const generator = ready && (
    <div className="toolbar">
      <button
        type="button"
        className={`button${plan && !over ? "" : " button-primary"}`}
        onClick={generate}
        disabled={generating}
        aria-busy={generating}
      >
        {generating && <span className="spinner" aria-hidden="true" />}
        {plan && !over
          ? "Régénérer mon plan"
          : "Générer mon plan de la semaine"}
      </button>
    </div>
  );

  return (
    <section className="week-plan" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} className="section-title">
        Mon plan de la semaine
      </h2>
      {state.status === "loading" && <Loading label="Chargement du plan…" />}
      {state.status === "failed" && (
        <Alert message="Impossible de charger ton plan." />
      )}
      {plan && (
        <p className="muted">
          {formatPlanPeriod(plan.weekStart)} · {PHASE_LABELS[plan.phase]}
        </p>
      )}
      {plan?.adjustment && (
        <p className="card state plan-adjustment" role="status">
          {plan.adjustment.reason}
        </p>
      )}
      {over && (
        <p className="card state plan-over" role="status">
          Ce plan est terminé : génère ta nouvelle semaine.
        </p>
      )}
      {over && generator}
      {plan && <PlanSessions plan={plan} />}
      {state.status === "loaded" && !plan && ready && (
        <p className="muted">
          Pas encore de plan : génère ta semaine sur tes jours disponibles.
        </p>
      )}
      <MissingInputs goal={goal} />
      {!over && generator}
      {error && <Alert message={error} />}
    </section>
  );
}
