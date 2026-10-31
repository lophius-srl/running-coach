import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  parseDuration,
  RACE_DISTANCES,
  validateGoal,
  WEEK_DAYS,
  type Goal,
  type GoalErrors,
  type GoalField,
  type GoalResponse,
} from "../worker/goals/rules";
import { MAX_DISTANCE_M, MIN_DISTANCE_M } from "../core/fitness";
import { formatDuration, localIsoDate } from "./format";
import { Paces } from "./Paces";

const HEADING_ID = "goal-title";

type Form = {
  distanceM: string;
  raceDate: string;
  targetTime: string;
  availableDays: number[];
};

const EMPTY_FORM: Form = {
  distanceM: "",
  raceDate: "",
  targetTime: "",
  availableDays: [],
};

type Status =
  "loading" | "loadFailed" | "ready" | "saving" | "saved" | "saveFailed";

const TIME_HINT =
  "Format h:mm:ss ou mm:ss, ex. 3:45:00 pour 3 h 45, 45:30 pour 45 min 30.";

// Premier élément focalisable de chaque champ, dans l'ordre du formulaire.
const FIELD_IDS: Record<GoalField, string> = {
  distanceM: "goal-distance",
  raceDate: "goal-date",
  targetTimeS: "goal-target",
  availableDays: "goal-day-1",
};

function toForm(goal: Goal): Form {
  return {
    distanceM: String(goal.distanceM),
    raceDate: goal.raceDate,
    targetTime:
      goal.targetTimeS === null ? "" : formatDuration(goal.targetTimeS),
    availableDays: goal.availableDays,
  };
}

// Chrono illisible → NaN, que validateGoal rejette avec le message de format.
function toInput(form: Form): Record<GoalField, unknown> {
  const duration = (text: string) => parseDuration(text) ?? Number.NaN;
  return {
    distanceM: Number(form.distanceM),
    raceDate: form.raceDate,
    targetTimeS:
      form.targetTime.trim() === "" ? null : duration(form.targetTime),
    availableDays: form.availableDays,
  };
}

function describedBy(...ids: (string | false | undefined)[]) {
  return ids.filter(Boolean).join(" ") || undefined;
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} className="field-error">
      <span className="alert-label">Erreur :</span> {error}
    </p>
  );
}

type FieldProps = {
  field: GoalField;
  label: string;
  hint?: string;
  errors: GoalErrors;
  children: (aria: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid": boolean;
  }) => ReactNode;
};

function Field({ field, label, hint, errors, children }: FieldProps) {
  const id = FIELD_IDS[field];
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="muted">
          {hint}
        </p>
      )}
      {children({
        id,
        "aria-describedby": describedBy(
          hint && `${id}-hint`,
          errors[field] && `${id}-error`,
        ),
        "aria-invalid": Boolean(errors[field]),
      })}
      <FieldError id={`${id}-error`} error={errors[field]} />
    </div>
  );
}

function DistanceOptions() {
  return (
    <>
      <option value="">Choisir…</option>
      {RACE_DISTANCES.map((race) => (
        <option key={race.distanceM} value={race.distanceM}>
          {race.label}
        </option>
      ))}
    </>
  );
}

type PacesState = Omit<GoalResponse, "goal">;
type SaveResult = { errors: GoalErrors } | PacesState;

async function fetchGoal(): Promise<GoalResponse> {
  const response = await fetch("/api/goal");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as GoalResponse;
}

async function saveGoal(
  input: Record<GoalField, unknown>,
): Promise<SaveResult> {
  const response = await fetch("/api/goal", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 400) {
    return (await response.json()) as { errors: GoalErrors };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { paces, basis } = (await response.json()) as GoalResponse;
  return { paces, basis };
}

// Allures, ou la raison de leur absence : pas de course exploitable, ou pas encore d'objectif.
function PacesOrReason({ paces, basis }: PacesState) {
  if (paces && basis) return <Paces paces={paces} basis={basis} />;
  return (
    <p className="muted paces-missing">
      {basis
        ? "Enregistre ton objectif pour voir tes allures."
        : "Pas d'allures pour l'instant : aucune course exploitable sur les 8 dernières " +
          `semaines (course à pied de ${MIN_DISTANCE_M / 1000} à ${MAX_DISTANCE_M / 1000} km, ` +
          "à une allure réaliste). Synchronise " +
          "tes activités Strava ou importe ton historique ci-dessous."}
    </p>
  );
}

export function GoalForm() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [errors, setErrors] = useState<GoalErrors>({});
  const [status, setStatus] = useState<Status>("loading");
  const [fitness, setFitness] = useState<PacesState>({
    paces: null,
    basis: null,
  });
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Sans objectif chargé, pas de formulaire : un enregistrement écraserait l'objectif existant.
  useEffect(() => {
    fetchGoal()
      .then(({ goal, paces, basis }) => {
        if (goal) setForm(toForm(goal));
        setFitness({ paces, basis });
        setStatus("ready");
      })
      .catch(() => setStatus("loadFailed"));
  }, [loadAttempt]);

  function retryLoad() {
    setStatus("loading");
    setLoadAttempt((attempt) => attempt + 1);
  }

  function update(changes: Partial<Form> | ((current: Form) => Partial<Form>)) {
    setForm((current) => ({
      ...current,
      ...(typeof changes === "function" ? changes(current) : changes),
    }));
    if (status === "saved") setStatus("ready");
  }

  function toggleDay(day: number, checked: boolean) {
    update((current) => {
      const others = current.availableDays.filter((d) => d !== day);
      return { availableDays: checked ? [...others, day] : others };
    });
  }

  function showErrors(found: GoalErrors) {
    setErrors(found);
    const first = (Object.keys(FIELD_IDS) as GoalField[]).find((f) => found[f]);
    if (first) document.getElementById(FIELD_IDS[first])?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = toInput(form);
    const local = validateGoal(input, localIsoDate(new Date()));
    if (!local.ok) return showErrors(local.errors);
    setStatus("saving");
    try {
      const result = await saveGoal(input);
      if ("errors" in result) {
        showErrors(result.errors);
        setStatus("ready");
      } else {
        showErrors({});
        setFitness(result);
        setStatus("saved");
      }
    } catch {
      setStatus("saveFailed");
    }
  }

  if (status === "loading") return null;

  const heading = (
    <h2 id={HEADING_ID} className="section-title">
      Mon objectif
    </h2>
  );

  if (status === "loadFailed") {
    return (
      <section aria-labelledby={HEADING_ID}>
        {heading}
        <div className="card state">
          <p className="alert" role="alert">
            <span className="alert-label">Erreur :</span> Impossible de charger
            ton objectif.
          </p>
          <p>
            <button type="button" className="button" onClick={retryLoad}>
              Réessayer
            </button>
          </p>
        </div>
      </section>
    );
  }

  const saving = status === "saving";
  const daysInvalid = Boolean(errors.availableDays);

  return (
    <section aria-labelledby={HEADING_ID}>
      {heading}
      <form className="card goal-form" onSubmit={submit} noValidate>
        <fieldset className="form-fields" disabled={saving}>
          <Field field="distanceM" label="Distance cible" errors={errors}>
            {(aria) => (
              <select
                {...aria}
                className="input"
                value={form.distanceM}
                onChange={(e) => update({ distanceM: e.target.value })}
              >
                <DistanceOptions />
              </select>
            )}
          </Field>
          <Field field="raceDate" label="Date de la course" errors={errors}>
            {(aria) => (
              <input
                {...aria}
                type="date"
                className="input"
                value={form.raceDate}
                onChange={(e) => update({ raceDate: e.target.value })}
              />
            )}
          </Field>
          <Field
            field="targetTimeS"
            label="Chrono visé (optionnel)"
            hint={`${TIME_HINT} Laisse vide pour juste finir.`}
            errors={errors}
          >
            {(aria) => (
              <input
                {...aria}
                className="input"
                autoComplete="off"
                value={form.targetTime}
                onChange={(e) => update({ targetTime: e.target.value })}
              />
            )}
          </Field>
          <fieldset
            className="field"
            aria-describedby={describedBy(
              "goal-days-hint",
              errors.availableDays && "goal-days-error",
            )}
          >
            <legend>Jours disponibles</legend>
            <p id="goal-days-hint" className="muted">
              Au moins 2 jours.
            </p>
            <div className="day-list">
              {WEEK_DAYS.map((label, index) => (
                <label key={label} className="day">
                  <input
                    id={`goal-day-${index + 1}`}
                    type="checkbox"
                    checked={form.availableDays.includes(index + 1)}
                    aria-invalid={daysInvalid}
                    aria-describedby={
                      daysInvalid ? "goal-days-error" : undefined
                    }
                    onChange={(e) => toggleDay(index + 1, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <FieldError id="goal-days-error" error={errors.availableDays} />
          </fieldset>
        </fieldset>
        <div className="toolbar">
          <button
            type="submit"
            className="button button-primary"
            disabled={saving}
            aria-busy={saving}
          >
            Enregistrer mon objectif
          </button>
          <span className="muted" role="status">
            {status === "saved" ? "Objectif enregistré." : ""}
          </span>
        </div>
        {status === "saveFailed" && (
          <p className="alert" role="alert">
            <span className="alert-label">Erreur :</span> Impossible
            d'enregistrer ton objectif, réessaie plus tard.
          </p>
        )}
      </form>
      <PacesOrReason {...fitness} />
    </section>
  );
}
