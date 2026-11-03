import { useEffect, useRef, useState } from "react";
import type {
  GeneratedPersonalToken,
  PersonalTokenStatus,
} from "../worker/personal-token/types";
import { formatStartDate } from "./format";
import { Alert, Loading } from "./ui";

// Section « Envoi depuis l'iPhone » (ADR 0005) : jeton personnel du Raccourci iOS. Le jeton n'est
// affiché qu'une fois, juste après sa génération ; ensuite seules ses dates sont connues.

const HEADING_ID = "phone-upload-title";
const TOKEN_INPUT_ID = "phone-upload-token";
const API = "/api/personal-token";

type Load =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; token: PersonalTokenStatus };

async function fetchStatus(): Promise<PersonalTokenStatus> {
  const response = await fetch(API);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as PersonalTokenStatus;
}

async function createToken(): Promise<GeneratedPersonalToken> {
  const response = await fetch(API, { method: "POST" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as GeneratedPersonalToken;
}

async function revokeToken(): Promise<void> {
  const response = await fetch(API, { method: "DELETE" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export function PhoneUpload() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetchStatus().then(
      (token) => {
        if (active) setLoad({ status: "loaded", token });
      },
      () => {
        if (active) setLoad({ status: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <section aria-labelledby={HEADING_ID} className="card import-section">
      <h2 id={HEADING_ID} className="section-title">
        Envoi depuis l'iPhone
      </h2>
      <p className="muted import-help">
        Un jeton personnel permet à un Raccourci iOS d'envoyer tes séances de
        montre sans te connecter. Le guide du Raccourci arrive bientôt.
      </p>
      {load.status === "loading" && <Loading label="Chargement du jeton…" />}
      {load.status === "failed" && (
        <>
          <Alert message="Impossible de charger l'état de ton jeton." />
          <div className="toolbar">
            <button
              type="button"
              className="button"
              onClick={() => {
                setLoad({ status: "loading" });
                setAttempt((count) => count + 1);
              }}
            >
              Réessayer
            </button>
          </div>
        </>
      )}
      {load.status === "loaded" && <TokenPanel initial={load.token} />}
    </section>
  );
}

type Busy = "idle" | "generating" | "revoking";

const BUSY_LABELS: Record<Exclude<Busy, "idle">, string> = {
  generating: "Génération…",
  revoking: "Révocation…",
};

export function TokenPanel({ initial }: { initial: PersonalTokenStatus }) {
  const [token, setToken] = useState(initial);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  // Après un échec, le serveur a pu appliquer la demande : on relit l'état. Si le jeton affiché
  // n'est plus celui du serveur (autre date de création), on le masque.
  function refreshAfterFailure(message: string) {
    setError(message);
    fetchStatus().then(
      (status) => {
        if (status.createdAt !== token.createdAt) setFresh(null);
        setToken(status);
      },
      () => undefined,
    );
  }

  async function generate() {
    if (
      token.exists &&
      !window.confirm(
        "Regénérer le jeton ? L'ancien cessera de fonctionner dans ton Raccourci.",
      )
    ) {
      return;
    }
    setBusy("generating");
    setError(null);
    setNotice("");
    try {
      const created = await createToken();
      setFresh(created.token);
      setToken({
        exists: true,
        createdAt: created.createdAt,
        lastUsedAt: null,
      });
      setNotice("Nouveau jeton généré.");
    } catch {
      refreshAfterFailure("Impossible de générer le jeton. Réessaie.");
    }
    setBusy("idle");
  }

  async function revoke() {
    if (
      !window.confirm(
        "Révoquer le jeton ? Le Raccourci ne pourra plus envoyer de séances.",
      )
    ) {
      return;
    }
    setBusy("revoking");
    setError(null);
    setNotice("");
    try {
      await revokeToken();
      setFresh(null);
      setToken({ exists: false, createdAt: null, lastUsedAt: null });
      setNotice("Jeton révoqué.");
    } catch {
      refreshAfterFailure("Impossible de révoquer le jeton. Réessaie.");
    }
    setBusy("idle");
  }

  return (
    <>
      {fresh !== null && <FreshToken token={fresh} />}
      {token.exists && token.createdAt !== null && (
        <dl className="run-stats">
          <div>
            <dt>Créé le</dt>
            <dd>{formatStartDate(token.createdAt)}</dd>
          </div>
          <div>
            <dt>Dernière utilisation</dt>
            <dd>
              {token.lastUsedAt === null
                ? "jamais"
                : formatStartDate(token.lastUsedAt)}
            </dd>
          </div>
        </dl>
      )}
      {error !== null && <Alert message={error} />}
      <div className="toolbar">
        <button
          type="button"
          className="button button-primary"
          disabled={busy !== "idle"}
          onClick={generate}
        >
          {busy === "generating"
            ? BUSY_LABELS.generating
            : token.exists
              ? "Regénérer"
              : "Générer mon jeton"}
        </button>
        {token.exists && (
          <button
            type="button"
            className="button"
            disabled={busy !== "idle"}
            onClick={revoke}
          >
            {busy === "revoking" ? BUSY_LABELS.revoking : "Révoquer"}
          </button>
        )}
      </div>
      <p className="muted" role="status">
        {notice}
      </p>
    </>
  );
}

export function FreshToken({ token }: { token: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  // Focus sur le jeton dès qu'il apparaît : il est sélectionné, prêt à copier.
  useEffect(() => input.current?.focus(), [token]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopyStatus("Jeton copié.");
    } catch {
      // Presse-papiers indisponible (contexte non sécurisé, refus) : on sélectionne le texte.
      input.current?.select();
      setCopyStatus("Jeton sélectionné : copie-le manuellement.");
    }
  }

  return (
    <div className="field">
      <label htmlFor={TOKEN_INPUT_ID}>Ton jeton</label>
      <div className="token-row">
        <input
          ref={input}
          id={TOKEN_INPUT_ID}
          className="input token-input"
          type="text"
          readOnly
          value={token}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="button" onClick={copy}>
          Copier
        </button>
      </div>
      <p className="plan-note">
        Copie-le maintenant : il ne sera plus affiché. En cas de perte,
        regénère-en un.
      </p>
      <p className="muted" role="status">
        {copyStatus}
      </p>
    </div>
  );
}
