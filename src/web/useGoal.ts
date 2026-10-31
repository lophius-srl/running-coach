import { useCallback, useEffect, useRef, useState } from "react";
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
  // Incrémentée à chaque enregistrement : une lecture lancée avant ne l'écrase pas.
  const version = useRef(0);

  useEffect(() => {
    const startedAt = version.current;
    let active = true;
    const isCurrent = () => active && version.current === startedAt;
    fetchGoal().then(
      (data) => {
        if (isCurrent()) setState({ status: "loaded", data });
      },
      () => {
        // Un rechargement en échec garde les données déjà affichées.
        if (isCurrent())
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
  const replace = useCallback((data: GoalResponse) => {
    version.current += 1;
    setState({ status: "loaded", data });
  }, []);

  return { state, refresh, retry, replace };
}
