import { useRef, useState, type ChangeEvent } from "react";
import { uploadFit, type FitUploadOutcome } from "./fit-upload";
import { Alert } from "./ui";

// Repli du Raccourci iOS (ADR 0005) : envoi d'un fichier FIT depuis n'importe quel appareil.

const HEADING_ID = "fit-upload-title";

type State =
  | { status: "idle" }
  | { status: "sending" }
  | ({ status: "done" } & FitUploadOutcome);

export function FitUpload() {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ status: "idle" });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setState({ status: "sending" });
    setState({ status: "done", ...(await uploadFit(file)) });
  }

  return (
    <section aria-labelledby={HEADING_ID} className="card import-section">
      <h2 id={HEADING_ID} className="section-title">
        Séance de la montre
      </h2>
      <p className="muted import-help">
        Exporte une séance au format FIT depuis l'app Suunto, puis envoie le
        fichier ici. Il est conservé tel quel avec ton historique.
      </p>
      <input
        ref={input}
        type="file"
        accept=".fit"
        hidden
        onChange={onFile}
        aria-label="Fichier FIT"
      />
      <div className="toolbar">
        <button
          type="button"
          className="button button-primary"
          disabled={state.status === "sending"}
          onClick={() => input.current?.click()}
        >
          {state.status === "sending" ? "Envoi…" : "Importer un fichier FIT"}
        </button>
      </div>
      {state.status === "done" && !state.ok && (
        <Alert message={state.message} />
      )}
      <p className="muted" role="status">
        {state.status === "done" && state.ok ? state.message : ""}
      </p>
    </section>
  );
}
