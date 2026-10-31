import type { GoalResponse } from "../worker/goals/rules";
import { GoalForm } from "./GoalForm";
import { Paces } from "./Paces";
import { Loading } from "./ui";
import type { GoalState } from "./useGoal";

type Props = {
  goal: GoalState;
  onRetry: () => void;
  onSaved: (response: GoalResponse) => void;
};

// Formulaire d'objectif | zones d'allures (côte à côte sur grand écran).
export function GoalView({ goal, onRetry, onSaved }: Props) {
  if (goal.status === "loading") {
    return <Loading label="Chargement de ton objectif…" />;
  }
  if (goal.status === "failed") {
    return (
      <div className="card state">
        <p className="alert" role="alert">
          <span className="alert-label">Erreur :</span> Impossible de charger
          ton objectif.
        </p>
        <p>
          <button type="button" className="button" onClick={onRetry}>
            Réessayer
          </button>
        </p>
      </div>
    );
  }
  const { goal: saved, paces, basis } = goal.data;
  return (
    <div className="view-grid">
      <GoalForm goal={saved} onSaved={onSaved} />
      <Paces paces={paces} basis={basis} />
    </div>
  );
}
