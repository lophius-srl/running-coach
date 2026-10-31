import { useCallback, useRef, useState } from "react";

export type SyncState =
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

// Synchronisation Strava, tenue au niveau de l'app : changer d'onglet pendant une sync n'en perd
// ni le résultat ni l'alerte, et une seconde sync ne peut pas partir en parallèle.
// syncCount augmente à chaque sync réussie : les vues s'en servent pour recharger leurs données.
export function useSync(onSynced: () => void) {
  const [state, setState] = useState<SyncState>({ status: "idle" });
  const [syncCount, setSyncCount] = useState(0);
  const running = useRef(false);

  const synchronize = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setState({ status: "running" });
    const result = await requestSync().catch((): SyncState => ({
      status: "failed",
    }));
    running.current = false;
    setState(result);
    if (result.status !== "done") return;
    setSyncCount((count) => count + 1);
    onSynced();
  }, [onSynced]);

  return { state, synchronize, syncCount };
}
