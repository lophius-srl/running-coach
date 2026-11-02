// Formulaire des zones cardiaques et affichage de la zone cible (fonctions pures, sans React).

import {
  HEART_RATE_ZONES,
  karvonenZones,
  validateHeartRate,
  type HeartRateErrors,
  type HeartRateSettings,
  type HeartRateTarget,
} from "../core/heart-rate";

export type HeartRateForm = {
  restingHr: string;
  maxHr: string;
  zones: { low: string; high: string }[];
};

export const EMPTY_HEART_RATE_FORM: HeartRateForm = {
  restingHr: "",
  maxHr: "",
  zones: HEART_RATE_ZONES.map(() => ({ low: "", high: "" })),
};

export function toHeartRateForm(settings: HeartRateSettings): HeartRateForm {
  return {
    restingHr: String(settings.restingHr),
    maxHr: String(settings.maxHr),
    zones: settings.zones.map(({ low, high }) => ({
      low: String(low),
      high: String(high),
    })),
  };
}

// Champ vide ou illisible → NaN, que validateHeartRate rejette avec un message clair.
function bpm(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text.trim());
}

export function toHeartRateInput(form: HeartRateForm) {
  return {
    restingHr: bpm(form.restingHr),
    maxHr: bpm(form.maxHr),
    zones: form.zones.map(({ low, high }) => ({
      low: bpm(low),
      high: bpm(high),
    })),
  };
}

// « Calculer mes zones » : zones de Karvonen pré-remplies, ou les erreurs de FC repos / max.
export function computeZones(
  form: HeartRateForm,
): { form: HeartRateForm } | { errors: HeartRateErrors } {
  const { restingHr, maxHr } = toHeartRateInput(form);
  // Sans zones, la validation échoue toujours : seules ses erreurs de FC repos / max comptent.
  const result = validateHeartRate({ restingHr, maxHr });
  const errors: HeartRateErrors = {};
  if (!result.ok && result.errors.restingHr) {
    errors.restingHr = result.errors.restingHr;
  }
  if (!result.ok && result.errors.maxHr) errors.maxHr = result.errors.maxHr;
  if (errors.restingHr || errors.maxHr) return { errors };
  const { zones } = toHeartRateForm({
    restingHr,
    maxHr,
    zones: karvonenZones(restingHr, maxHr),
  });
  return { form: { ...form, zones } };
}

// Zone cible d'une séance : « Z2 · 134–148 bpm ».
export function formatHeartRateTarget({
  zone,
  low,
  high,
}: HeartRateTarget): string {
  return `${HEART_RATE_ZONES[zone - 1].label} · ${low}–${high} bpm`;
}
