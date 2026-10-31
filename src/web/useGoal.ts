import { useCallback, useEffect, useState } from "react";
import type { GoalResponse } from "../worker/goals/rules";

export type GoalState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: GoalResponse };

async function fetchGoal(): Promise<GoalResponse> {
  const response = await fetch("/api/goal");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as GoalResponse;
}

// Objectif et allures, partagés par « Ma semaine » (résumé) et « Objectif & allures ».
// Rechargés sans écran de chargement à chaque changement de refreshKey (la vue affichée), pour
// tenir compte d'une synchronisation ou d'un import d'historique fait entre-temps.
export function useGoal(refreshKey: string) {
  const [state, setState] = useState<GoalState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetchGoal().then(
      (data) => {
        if (active) setState({ status: "loaded", data });
      },
      () => {
        // Un rechargement en échec garde les données déjà affichées.
        if (active)
          setState((current) =>
            current.status === "loaded" ? current : { status: "failed" },
          );
      },
    );
    return () => {
      active = false;
    };
  }, [refreshKey, attempt]);

  const refresh = useCallback(() => setAttempt((count) => count + 1), []);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);
  const replace = useCallback(
    (data: GoalResponse) => setState({ status: "loaded", data }),
    [],
  );

  return { state, refresh, retry, replace };
}
