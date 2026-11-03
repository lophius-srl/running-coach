import { useEffect, useState } from "react";
import type { RecentImport } from "../worker/imports/types";
import { fetchRecentImports, recentImportLine } from "./recent-imports";

// Liste compacte des 20 derniers envois FIT (bouton ou Raccourci), rechargée quand `version` change.

type Load =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; imports: RecentImport[] };

export function RecentImportsList({ imports }: { imports: RecentImport[] }) {
  if (imports.length === 0) {
    return <p className="muted">Aucun envoi pour l'instant.</p>;
  }
  return (
    <ul className="recent-imports">
      {imports.map((item) => {
        const line = recentImportLine(item);
        return (
          <li key={item.id}>
            <span className={line.ok ? "badge" : "badge badge-error"}>
              {line.status}
            </span>{" "}
            <time className="muted" dateTime={item.receivedAt}>
              {line.receivedAt}
            </time>
            {line.session !== null && (
              <span className="recent-import-session">{line.session}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function RecentImports({ version }: { version: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchRecentImports().then(
      (imports) => active && setLoad({ status: "loaded", imports }),
      () => active && setLoad({ status: "failed" }),
    );
    return () => {
      active = false;
    };
  }, [version]);

  return (
    <div>
      <h3 className="recent-imports-title">Derniers imports</h3>
      {load.status === "loading" && <p className="muted">Chargement…</p>}
      {load.status === "failed" && (
        <p className="muted">Liste des derniers imports indisponible.</p>
      )}
      {load.status === "loaded" && <RecentImportsList imports={load.imports} />}
    </div>
  );
}
