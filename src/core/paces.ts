// Allures d'entraînement depuis un chrono de référence : fonctions pures, déterministes, sans I/O.
//
// Méthode VDOT de Jack Daniels (Daniels & Gilbert, « Oxygen Power », 1979 ;
// J. Daniels, « Daniels' Running Formula », 3e éd., 2014) :
//   VO2(v)    = -4,60 + 0,182258·v + 0,000104·v²   (ml/kg/min, v en m/min)
//   %max(t)   = 0,8 + 0,1894393·e^(-0,012778·t) + 0,2989558·e^(-0,1932605·t)   (t en min)
//   VDOT      = VO2(distance / t) / %max(t)
// Une allure d'entraînement est la vitesse dont le VO2 vaut un pourcentage du VDOT
// (inverse de VO2(v)) ; un chrono prédit est la durée t telle que VDOT(distance, t) = VDOT.

export type PaceRange = {
  fastSPerKm: number; // borne rapide, s/km entières
  slowSPerKm: number; // borne lente, s/km entières
};

export type TrainingPaces = {
  endurance: PaceRange;
  threshold: PaceRange;
  vma: PaceRange;
  race: PaceRange;
  predictedTimeS: number; // chrono prédit sur la distance de l'objectif, à la seconde
  targetWarning: string | null;
};

export type PaceInput = {
  distanceM: number; // distance de l'objectif
  targetTimeS: number | null;
  referenceDistanceM: number;
  referenceTimeS: number;
};

// Pourcentages du VDOT (Daniels) : E 59–74 %, resserré à 65–74 % pour coller aux fourchettes
// de ses tables ; T 83–88 % ; I 95–100 % (≈ vVO2max, la « VMA »).
export const ZONE_VDOT_SHARES = {
  endurance: [0.65, 0.74],
  threshold: [0.83, 0.88],
  vma: [0.95, 1],
} as const;

// Allure course : allure du chrono (visé, sinon prédit) ± 1 %.
export const RACE_PACE_MARGIN = 0.01;

// Chrono visé plus rapide que la prédiction de plus de 5 % = objectif jugé irréaliste.
export const UNREALISTIC_TARGET_GAP = 0.05;

function oxygenCost(speedMPerMin: number): number {
  return -4.6 + 0.182258 * speedMPerMin + 0.000104 * speedMPerMin ** 2;
}

function speedForOxygenCost(vo2: number): number {
  const a = 0.000104;
  const b = 0.182258;
  return (-b + Math.sqrt(b * b + 4 * a * (vo2 + 4.6))) / (2 * a);
}

function vo2maxShare(minutes: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes)
  );
}

export function vdot(distanceM: number, timeS: number): number {
  const minutes = timeS / 60;
  return oxygenCost(distanceM / minutes) / vo2maxShare(minutes);
}

// VDOT décroît avec la durée : dichotomie entre 1 min et 50 h (au-delà de 15 min/km sur marathon).
export function predictTimeS(score: number, distanceM: number): number {
  let fast = 1;
  let slow = 3000;
  for (let i = 0; i < 60; i++) {
    const middle = (fast + slow) / 2;
    if (vdot(distanceM, middle * 60) > score) fast = middle;
    else slow = middle;
  }
  return Math.round(((fast + slow) / 2) * 60);
}

function paceAtShare(score: number, share: number): number {
  return Math.round(60000 / speedForOxygenCost(score * share));
}

function zone(score: number, [low, high]: readonly [number, number]) {
  return {
    fastSPerKm: paceAtShare(score, high),
    slowSPerKm: paceAtShare(score, low),
  };
}

function targetWarning(targetTimeS: number | null, predictedTimeS: number) {
  if (targetTimeS === null) return null;
  const gap = (predictedTimeS - targetTimeS) / predictedTimeS;
  if (gap <= UNREALISTIC_TARGET_GAP) return null;
  return `Ton chrono visé est ${Math.round(gap * 100)} % plus rapide que ce que prédit ta référence.`;
}

export function trainingPaces(input: PaceInput): TrainingPaces {
  const score = vdot(input.referenceDistanceM, input.referenceTimeS);
  const predictedTimeS = predictTimeS(score, input.distanceM);
  const racePace =
    (input.targetTimeS ?? predictedTimeS) / (input.distanceM / 1000);
  return {
    endurance: zone(score, ZONE_VDOT_SHARES.endurance),
    threshold: zone(score, ZONE_VDOT_SHARES.threshold),
    vma: zone(score, ZONE_VDOT_SHARES.vma),
    race: {
      fastSPerKm: Math.round(racePace * (1 - RACE_PACE_MARGIN)),
      slowSPerKm: Math.round(racePace * (1 + RACE_PACE_MARGIN)),
    },
    predictedTimeS,
    targetWarning: targetWarning(input.targetTimeS, predictedTimeS),
  };
}
