import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  parseDuration,
  RACE_DISTANCES,
  validateGoal,
  WEEK_DAYS,
  type GoalErrors,
  type GoalField,
  type SavedGoal,
} from "../worker/goals/rules";
import { formatDuration, localIsoDate } from "./format";

const HEADING_ID = "goal-title";

type Form = {
  distanceM: string;
  raceDate: string;
  targetTime: string;
  referenceDistanceM: string;
  referenceTime: string;
  availableDays: number[];
};

const EMPTY_FORM: Form = {
  distanceM: "",
  raceDate: "",
  targetTime: "",
  referenceDistanceM: "",
  referenceTime: "",
  availableDays: [],
};

type Status = "loading" | "ready" | "saving" | "saved" | "failed";

// Premier élément focalisable de chaque champ, dans l'ordre du formulaire.
const FIELD_IDS: Record<GoalField, string> = {
  distanceM: "goal-distance",
  raceDate: "goal-date",
  targetTimeS: "goal-target",
  referenceDistanceM: "goal-ref-distance",
  referenceTimeS: "goal-ref-time",
  availableDays: "goal-day-1",
};

function toForm(goal: SavedGoal): Form {
  return {
    distanceM: String(goal.distanceM),
    raceDate: goal.raceDate,
    targetTime:
      goal.targetTimeS === null ? "" : formatDuration(goal.targetTimeS),
    referenceDistanceM: goal.referenceDistanceM?.toString() ?? "",
    referenceTime:
      goal.referenceTimeS === null ? "" : formatDuration(goal.referenceTimeS),
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
    referenceDistanceM: Number(form.referenceDistanceM),
    referenceTimeS: duration(form.referenceTime),
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

async function saveGoal(
  input: Record<GoalField, unknown>,
): Promise<GoalErrors | null> {
  const response = await fetch("/api/goal", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 400) {
    return ((await response.json()) as { errors: GoalErrors }).errors;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return null;
}

export function GoalForm() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [errors, setErrors] = useState<GoalErrors>({});
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    fetch("/api/goal")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ goal: SavedGoal | null }>;
      })
      .then(({ goal }) => {
        if (goal) setForm(toForm(goal));
        setStatus("ready");
      })
      .catch(() => setStatus("failed"));
  }, []);

  function update(changes: Partial<Form>) {
    setForm({ ...form, ...changes });
    if (status === "saved") setStatus("ready");
  }

  function toggleDay(day: number, checked: boolean) {
    const others = form.availableDays.filter((d) => d !== day);
    update({ availableDays: checked ? [...others, day] : others });
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
      const serverErrors = await saveGoal(input);
      showErrors(serverErrors ?? {});
      setStatus(serverErrors ? "ready" : "saved");
    } catch {
      setStatus("failed");
    }
  }

  if (status === "loading") return null;

  return (
    <section aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} className="section-title">
        Mon objectif
      </h2>
      <form className="card goal-form" onSubmit={submit} noValidate>
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
          hint="Format h:mm:ss ou mm:ss. Laisse vide pour juste finir."
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
        <Field
          field="referenceDistanceM"
          label="Distance de ton chrono de référence récent"
          errors={errors}
        >
          {(aria) => (
            <select
              {...aria}
              className="input"
              value={form.referenceDistanceM}
              onChange={(e) => update({ referenceDistanceM: e.target.value })}
            >
              <DistanceOptions />
            </select>
          )}
        </Field>
        <Field
          field="referenceTimeS"
          label="Chrono de référence"
          hint="Format h:mm:ss ou mm:ss."
          errors={errors}
        >
          {(aria) => (
            <input
              {...aria}
              className="input"
              autoComplete="off"
              value={form.referenceTime}
              onChange={(e) => update({ referenceTime: e.target.value })}
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
                  onChange={(e) => toggleDay(index + 1, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
          <FieldError id="goal-days-error" error={errors.availableDays} />
        </fieldset>
        <div className="toolbar">
          <button
            type="submit"
            className="button button-primary"
            disabled={status === "saving"}
            aria-busy={status === "saving"}
          >
            Enregistrer mon objectif
          </button>
          <span className="muted" role="status">
            {status === "saved" ? "Objectif enregistré." : ""}
          </span>
        </div>
        {status === "failed" && (
          <p className="alert" role="alert">
            <span className="alert-label">Erreur :</span> Impossible de charger
            ou d'enregistrer ton objectif, réessaie plus tard.
          </p>
        )}
      </form>
    </section>
  );
}
