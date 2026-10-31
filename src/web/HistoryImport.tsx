import { useState, type ChangeEvent } from "react";
import { readActivitiesCsv, type ImportedRun } from "../core/history-csv";
import { formatDay } from "./format";
import {
  fileProblem,
  payloadBatches,
  postBatch,
  previewOf,
  readErrorMessage,
  sendBatches,
  sendErrorMessage,
  startProgress,
  type Preview,
  type Progress,
} from "./history-import";

// Import de l'historique depuis l'export de compte Strava (ADR 0004) : le fichier est lu dans le
// navigateur ; seules les courses résumées partent, par lots, après confirmation de l'aperçu.

const HEADING_ID = "history-import-title";

type Loaded = { preview: Preview; batches: ImportedRun[][] };

type State =
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | ({ status: "preview" } & Loaded)
  | ({ status: "sending"; progress: Progress } & Loaded)
  | ({ status: "failed"; progress: Progress; message: string } & Loaded)
  | { status: "done"; preview: Preview; progress: Progress };

async function readFile(file: File): Promise<State> {
  const problem = fileProblem(file);
  if (problem) return { status: "invalid", message: problem };
  const result = readActivitiesCsv(await file.text(), Date.now());
  if (!result.ok)
    return { status: "invalid", message: readErrorMessage(result) };
  const { runs } = result.file;
  return {
    status: "preview",
    preview: previewOf(result.file),
    batches: payloadBatches(runs),
  };
}

function Help() {
  return (
    <div className="muted history-help">
      <p>Pour récupérer tout ton historique Strava :</p>
      <ol>
        <li>
          Sur strava.com, ouvre Paramètres → Mon compte → « Télécharger ou
          supprimer votre compte », puis demande ton archive.
        </li>
        <li>Strava t'envoie par e-mail un lien vers une archive .zip.</li>
        <li>
          Extrais de cette archive le fichier <code>activities.csv</code> et
          dépose-le ci-dessous (pas le .zip).
        </li>
      </ol>
      <p>
        Le fichier est lu sur ton appareil : seules la date, la distance, la
        durée, le nom, le type, la FC moyenne et le dénivelé de chaque course
        sont envoyés.
      </p>
    </div>
  );
}

function PreviewFigures({ preview }: { preview: Preview }) {
  const period =
    preview.firstDate && preview.lastDate
      ? `du ${formatDay(preview.firstDate)} au ${formatDay(preview.lastDate)}`
      : "–";
  return (
    <dl className="run-stats">
      <div>
        <dt>Courses trouvées</dt>
        <dd>{preview.runs}</dd>
      </div>
      <div>
        <dt>Période</dt>
        <dd>{period}</dd>
      </div>
      <div>
        <dt>Lignes ignorées</dt>
        <dd>
          {preview.ignored}{" "}
          <span className="muted">
            ({preview.otherSports} autres sports, {preview.invalid} invalides,{" "}
            {preview.duplicates} en double)
          </span>
        </dd>
      </div>
    </dl>
  );
}

function Report({
  preview,
  progress,
}: {
  preview: Preview;
  progress: Progress;
}) {
  return (
    <dl className="run-stats">
      <div>
        <dt>Importées</dt>
        <dd>{progress.inserted}</dd>
      </div>
      <div>
        <dt>Déjà présentes</dt>
        <dd>{progress.alreadyPresent}</dd>
      </div>
      <div>
        <dt>Ignorées</dt>
        <dd>{preview.ignored}</dd>
      </div>
    </dl>
  );
}

export function HistoryImport() {
  const [state, setState] = useState<State>({ status: "idle" });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setState(
      await readFile(file).catch((): State => ({
        status: "invalid",
        message: "Impossible de lire ce fichier.",
      })),
    );
  }

  async function send({ preview, batches }: Loaded, from: Progress) {
    const loaded: Loaded = { preview, batches };
    setState({ status: "sending", ...loaded, progress: from });
    const outcome = await sendBatches(
      loaded.batches,
      from,
      postBatch,
      (progress) => setState({ status: "sending", ...loaded, progress }),
    );
    setState(
      outcome.ok
        ? {
            status: "done",
            preview: loaded.preview,
            progress: outcome.progress,
          }
        : {
            status: "failed",
            ...loaded,
            progress: outcome.progress,
            message: sendErrorMessage(outcome.error),
          },
    );
  }

  const busy = state.status === "sending";

  return (
    <section aria-labelledby={HEADING_ID} className="card history-import">
      <h2 id={HEADING_ID} className="section-title">
        Importer mon historique Strava
      </h2>
      <Help />
      <div className="field">
        <label htmlFor="history-file">Fichier activities.csv</label>
        <input
          id="history-file"
          className="input"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={onFile}
        />
      </div>
      {state.status === "invalid" && (
        <p className="alert" role="alert">
          <span className="alert-label">Erreur :</span> {state.message}
        </p>
      )}
      {(state.status === "preview" ||
        state.status === "sending" ||
        state.status === "failed") && (
        <>
          <h3>Aperçu avant envoi</h3>
          <PreviewFigures preview={state.preview} />
        </>
      )}
      {state.status === "preview" && (
        <div className="toolbar">
          <button
            type="button"
            className="button button-primary"
            disabled={state.preview.runs === 0}
            onClick={() => send(state, startProgress(state.batches.length))}
          >
            Importer {state.preview.runs} course(s)
          </button>
        </div>
      )}
      {(state.status === "sending" || state.status === "failed") && (
        <p className="toolbar">
          <progress
            value={state.progress.nextBatch}
            max={state.progress.totalBatches}
            aria-label="Progression de l'import"
          />
          <span className="muted" role="status">
            Lot {state.progress.nextBatch} / {state.progress.totalBatches}{" "}
            envoyé(s)
          </span>
        </p>
      )}
      {state.status === "failed" && (
        <>
          <p className="alert" role="alert">
            <span className="alert-label">Erreur :</span> {state.message}
          </p>
          <div className="toolbar">
            <button
              type="button"
              className="button button-primary"
              onClick={() => send(state, state.progress)}
            >
              Relancer l'import
            </button>
          </div>
        </>
      )}
      {state.status === "done" && (
        <>
          <h3 role="status">Import terminé</h3>
          <Report preview={state.preview} progress={state.progress} />
        </>
      )}
    </section>
  );
}
