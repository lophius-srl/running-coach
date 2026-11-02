import { useEffect, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import {
  HEART_RATE_ZONES,
  validateHeartRate,
  type HeartRateErrors,
  type HeartRateResponse,
  type HeartRateSettings,
} from "../core/heart-rate";
import {
  computeZones,
  EMPTY_HEART_RATE_FORM,
  toHeartRateForm,
  toHeartRateInput,
  type HeartRateForm,
} from "./heart-rate";
import { Alert, Loading } from "./ui";

const HEADING_ID = "heart-rate-title";
const API = "/api/heart-rate-zones";

type Load =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; settings: HeartRateSettings | null };

async function fetchZones(): Promise<HeartRateSettings | null> {
  const response = await fetch(API);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as HeartRateResponse).heartRate;
}

async function saveZones(
  input: unknown,
): Promise<{ errors: HeartRateErrors } | HeartRateResponse> {
  const response = await fetch(API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 400) {
    return (await response.json()) as { errors: HeartRateErrors };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as HeartRateResponse;
}

// Section « Mes zones cardiaques » de la vue Objectif : chargée à part de l'objectif (API dédiée).
export function HeartRateZones() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    fetchZones().then(
      (settings) => {
        if (active) setLoad({ status: "loaded", settings });
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
    <section aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} className="section-title">
        Mes zones cardiaques
      </h2>
      {load.status === "loading" && (
        <Loading label="Chargement de tes zones cardiaques…" />
      )}
      {load.status === "failed" && (
        <div className="card state">
          <Alert message="Impossible de charger tes zones cardiaques." />
          <p>
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
          </p>
        </div>
      )}
      {load.status === "loaded" && <ZonesForm settings={load.settings} />}
    </section>
  );
}

type Status = "ready" | "saving" | "saved" | "computed" | "saveFailed";

const FIELD_IDS = { restingHr: "hr-resting", maxHr: "hr-max" } as const;
const zoneInputId = (zone: number) => `hr-zone-${zone}-low`;
const ZONES_ERROR_ID = "hr-zones-error";

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} className="field-error">
      <span className="alert-label">Erreur :</span> {error}
    </p>
  );
}

// Formulaire affiché une fois les zones chargées, pour ne pas écraser des zones existantes.
function ZonesForm({ settings }: { settings: HeartRateSettings | null }) {
  const [form, setForm] = useState<HeartRateForm>(() =>
    settings ? toHeartRateForm(settings) : EMPTY_HEART_RATE_FORM,
  );
  const [errors, setErrors] = useState<HeartRateErrors>({});
  const [status, setStatus] = useState<Status>("ready");

  function update(changes: Partial<HeartRateForm>) {
    setForm((current) => ({ ...current, ...changes }));
    if (status === "saved" || status === "computed") setStatus("ready");
  }

  function updateZone(index: number, bound: "low" | "high", value: string) {
    update({
      zones: form.zones.map((zone, i) =>
        i === index ? { ...zone, [bound]: value } : zone,
      ),
    });
  }

  function showErrors(found: HeartRateErrors) {
    setErrors(found);
    const id = found.restingHr
      ? FIELD_IDS.restingHr
      : found.maxHr
        ? FIELD_IDS.maxHr
        : found.zones && zoneInputId(found.zone ?? 1);
    if (id) document.getElementById(id)?.focus();
  }

  function compute() {
    const result = computeZones(form);
    if ("errors" in result) return showErrors(result.errors);
    setForm(result.form);
    setErrors({});
    setStatus("computed");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = toHeartRateInput(form);
    const local = validateHeartRate(input);
    if (!local.ok) return showErrors(local.errors);
    setStatus("saving");
    try {
      const result = await saveZones(input);
      if ("errors" in result) {
        // Champs réactivés avant d'y placer le focus.
        flushSync(() => setStatus("ready"));
        showErrors(result.errors);
      } else {
        showErrors({});
        setStatus("saved");
      }
    } catch {
      setStatus("saveFailed");
    }
  }

  const saving = status === "saving";
  const field = (name: keyof typeof FIELD_IDS, label: string) => {
    const id = FIELD_IDS[name];
    const error = errors[name];
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="input hr-input"
          inputMode="numeric"
          autoComplete="off"
          value={form[name]}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => update({ [name]: e.target.value })}
        />
        <FieldError id={`${id}-error`} error={error} />
      </div>
    );
  };

  return (
    <form className="card hr-form" onSubmit={submit} noValidate>
      <p className="muted">
        Repères de fréquence cardiaque affichés sur chaque séance de ton plan.
        Saisis tes zones en bpm, ou calcule-les depuis ta FC repos et ta FC max
        (méthode de Karvonen), puis ajuste-les si besoin.
      </p>
      <fieldset className="form-fields" disabled={saving}>
        <div className="hr-calculator">
          {field("restingHr", "FC repos (bpm)")}
          {field("maxHr", "FC max (bpm)")}
          <button type="button" className="button" onClick={compute}>
            Calculer mes zones
          </button>
        </div>
        <table className="hr-table">
          <caption className="visually-hidden">
            Bornes de mes zones cardiaques, en bpm
          </caption>
          <thead>
            <tr>
              <th scope="col">Zone</th>
              <th scope="col">De (bpm)</th>
              <th scope="col">À (bpm)</th>
            </tr>
          </thead>
          <tbody>
            {HEART_RATE_ZONES.map(({ label, name }, index) => {
              const invalid =
                Boolean(errors.zones) && errors.zone === index + 1;
              const bound = (key: "low" | "high", text: string) => (
                <td>
                  <input
                    id={key === "low" ? zoneInputId(index + 1) : undefined}
                    className="input hr-input"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={`${label} ${name.toLowerCase()}, ${text} (bpm)`}
                    aria-invalid={invalid}
                    aria-describedby={errors.zones ? ZONES_ERROR_ID : undefined}
                    value={form.zones[index][key]}
                    onChange={(e) => updateZone(index, key, e.target.value)}
                  />
                </td>
              );
              return (
                <tr key={label}>
                  <th scope="row">
                    <strong>{label}</strong>{" "}
                    <span className="muted">{name}</span>
                  </th>
                  {bound("low", "borne basse")}
                  {bound("high", "borne haute")}
                </tr>
              );
            })}
          </tbody>
        </table>
        <FieldError id={ZONES_ERROR_ID} error={errors.zones} />
      </fieldset>
      <div className="toolbar">
        <button
          type="submit"
          className="button button-primary"
          disabled={saving}
          aria-busy={saving}
        >
          Enregistrer mes zones
        </button>
        <span className="muted" role="status">
          {status === "saved" && "Zones cardiaques enregistrées."}
          {status === "computed" &&
            "Zones calculées : ajuste-les si besoin, puis enregistre."}
        </span>
      </div>
      {status === "saveFailed" && (
        <Alert message="Impossible d'enregistrer tes zones, réessaie plus tard." />
      )}
    </form>
  );
}
