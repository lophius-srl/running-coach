// Plan de la semaine (issue #15) : fonctions pures, déterministes, sans I/O.
//
// Entrées : jours disponibles, date de course, distance cible et date du jour ; mêmes entrées,
// même plan. Les allures n'entrent pas dans le calcul : chaque séance porte une zone
// (endurance, seuil, VMA, allure course) que l'appelant traduit en allure cible à l'affichage.
// Le plan ne contient donc aucune donnée dérivée de Strava (ADR 0003) et peut être stocké.
//
// Règles :
// - Phase selon les jours restants avant la course : affûtage ≤ 14 j, spécifique ≤ 56 j,
//   développement au-delà ; course aujourd'hui ou passée → pas de plan.
// - Séances dures : sortie longue, seuil, VMA et allure spécifique. Jamais deux jours de suite,
//   y compris du dimanche au lundi (la semaine type se répète).
// - Une sortie longue par semaine, le dimanche, sinon le samedi, sinon le dernier jour coché.
// - Séances de qualité en plus : 1 jusqu'à 4 jours ou en affûtage, 2 à partir de 5 jours
//   (avec 4 jours, 3 séances dures sur 4 serait trop) ;
//   placées le plus loin possible des autres séances dures (à égalité, le jour le plus tôt),
//   et abandonnées (footing) si aucun jour non adjacent ne reste.
// - Le lendemain de la sortie longue est une récupération ; les autres jours, du footing.
// - Le plan couvre les 7 jours à partir d'aujourd'hui, avant le jour de course ; les deux jours
//   qui précèdent la course, toute séance devient un footing court ; à 5 jours ou moins de la
//   course, la sortie longue devient un footing (pas de sortie longue la semaine de la course).
// - Sans jour disponible, pas de séance (l'API refuse la génération).

export type PlanPhase = "development" | "specific" | "taper";
export type SessionKind =
  "endurance" | "recovery" | "long" | "threshold" | "vma" | "race_pace";
export type PaceZone = "endurance" | "threshold" | "vma" | "race";

export type PlannedSession = {
  date: string; // AAAA-MM-JJ
  kind: SessionKind;
  durationMin: number;
  description: string;
};

export type WeekPlan = {
  weekStart: string; // AAAA-MM-JJ, premier jour couvert (aujourd'hui)
  phase: PlanPhase;
  sessions: PlannedSession[];
};

export type PlanInput = {
  availableDays: readonly number[]; // jours ISO (1 = lundi … 7 = dimanche)
  raceDate: string; // AAAA-MM-JJ
  distanceM: number;
  today: string; // AAAA-MM-JJ
};

export const TAPER_MAX_DAYS = 14;
export const SPECIFIC_MAX_DAYS = 56;
export const PRE_RACE_EASY_DAYS = 2;
export const NO_LONG_RUN_DAYS = 5;

export const HARD_KINDS: ReadonlySet<SessionKind> = new Set([
  "long",
  "threshold",
  "vma",
  "race_pace",
]);

export const SESSION_ZONE: Record<SessionKind, PaceZone> = {
  endurance: "endurance",
  recovery: "endurance",
  long: "endurance",
  threshold: "threshold",
  vma: "vma",
  race_pace: "race",
};

const QUALITY_KINDS: Record<PlanPhase, SessionKind[]> = {
  development: ["vma", "threshold"],
  specific: ["race_pace", "threshold"],
  taper: ["race_pace"],
};

// Durées en minutes par distance cible : 5 km, 10 km, semi, marathon.
const EASY_MIN = { development: [40, 45, 50, 55], taper: [30, 35, 40, 45] };
const LONG_MIN: Record<PlanPhase, number[]> = {
  development: [60, 75, 95, 120],
  specific: [65, 80, 105, 135],
  taper: [45, 50, 60, 75],
};
const RACE_REPS = {
  specific: ["6 × 800 m", "4 × 2 000 m", "3 × 4 000 m", "3 × 5 000 m"],
  taper: ["4 × 600 m", "3 × 1 000 m", "2 × 2 000 m", "2 × 3 000 m"],
};
const RACE_PACE_MIN = { specific: [55, 65, 80, 95], taper: [45, 45, 50, 55] };

const WARM_UP = "Échauffement 20 min en endurance, puis";
const COOL_DOWN = "Retour au calme 10 min.";
const DAY_MS = 24 * 60 * 60 * 1000;

function distanceIndex(distanceM: number): number {
  if (distanceM <= 5000) return 0;
  if (distanceM <= 10000) return 1;
  return distanceM <= 21098 ? 2 : 3;
}

export function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

export function isoWeekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay() || 7;
}

// Écart entre deux jours ISO sur une semaine circulaire : dimanche et lundi sont voisins.
export function dayGap(a: number, b: number): number {
  const gap = Math.abs(a - b);
  return Math.min(gap, 7 - gap);
}

export function planPhase(today: string, raceDate: string): PlanPhase | null {
  const days = daysBetween(today, raceDate);
  if (days <= 0) return null;
  if (days <= TAPER_MAX_DAYS) return "taper";
  return days <= SPECIFIC_MAX_DAYS ? "specific" : "development";
}

export function longRunDay(days: readonly number[]): number {
  if (days.includes(7)) return 7;
  return days.includes(6) ? 6 : Math.max(...days);
}

// Semaine type : séance de chaque jour ISO disponible.
export function weekTemplate(
  days: readonly number[],
  phase: PlanPhase,
): Map<number, SessionKind> {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return new Map();
  const longDay = longRunDay(sorted);
  const template = new Map<number, SessionKind>([[longDay, "long"]]);
  const qualityCount = phase === "taper" || sorted.length <= 4 ? 1 : 2;
  for (const kind of QUALITY_KINDS[phase].slice(0, qualityCount)) {
    const hardDays = [...template.keys()];
    let best: { day: number; gap: number } | null = null;
    for (const day of sorted) {
      if (template.has(day)) continue;
      const gap = Math.min(...hardDays.map((hard) => dayGap(day, hard)));
      if (gap >= 2 && (best === null || gap > best.gap)) best = { day, gap };
    }
    if (best) template.set(best.day, kind);
  }
  for (const day of sorted) {
    if (template.has(day)) continue;
    template.set(day, day === (longDay % 7) + 1 ? "recovery" : "endurance");
  }
  return template;
}

function sessionDetails(
  kind: SessionKind,
  phase: PlanPhase,
  index: number,
): Pick<PlannedSession, "durationMin" | "description"> {
  const easyPhase = phase === "taper" ? "taper" : "development";
  const racePhase = phase === "taper" ? "taper" : "specific";
  switch (kind) {
    case "long":
      return {
        durationMin: LONG_MIN[phase][index],
        description:
          phase === "taper"
            ? "Sortie longue raccourcie en endurance : garder le rythme sans se fatiguer."
            : "Sortie longue en endurance, à allure régulière et facile.",
      };
    case "vma":
      return {
        durationMin: 50,
        description: `${WARM_UP} 8 × 400 m à allure VMA, récupération 1 min 30 en trottinant. ${COOL_DOWN}`,
      };
    case "threshold":
      return {
        durationMin: 65,
        description: `${WARM_UP} 3 × 10 min à allure seuil, récupération 2 min en trottinant. ${COOL_DOWN}`,
      };
    case "race_pace":
      return {
        durationMin: RACE_PACE_MIN[racePhase][index],
        description: `${WARM_UP} ${RACE_REPS[racePhase][index]} à allure course, récupération 2 min en trottinant. ${COOL_DOWN}`,
      };
    case "recovery":
      return {
        durationMin: 30,
        description:
          "Footing très facile, au bas de la fourchette d'endurance, pour récupérer de la sortie longue.",
      };
    case "endurance":
      return {
        durationMin: EASY_MIN[easyPhase][index],
        description:
          "Footing en endurance, en aisance respiratoire (tu peux parler en courant).",
      };
  }
}

const PRE_RACE: Omit<PlannedSession, "date"> = {
  kind: "endurance",
  durationMin: 25,
  description:
    "Footing court et facile avec 4 accélérations progressives : arriver frais le jour de la course.",
};

// Plan des 7 jours à partir de `today` ; null si la course est aujourd'hui ou passée.
export function generateWeekPlan(input: PlanInput): WeekPlan | null {
  const phase = planPhase(input.today, input.raceDate);
  if (phase === null) return null;
  const template = weekTemplate(input.availableDays, phase);
  const index = distanceIndex(input.distanceM);
  const sessions: PlannedSession[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(input.today, offset);
    const planned = template.get(isoWeekday(date));
    const daysToRace = daysBetween(date, input.raceDate);
    if (planned === undefined || daysToRace <= 0) continue;
    const kind =
      planned === "long" && daysToRace <= NO_LONG_RUN_DAYS
        ? "endurance"
        : planned;
    const preRace = daysToRace <= PRE_RACE_EASY_DAYS;
    sessions.push({
      date,
      ...(preRace ? PRE_RACE : { kind, ...sessionDetails(kind, phase, index) }),
    });
  }
  return { weekStart: input.today, phase, sessions };
}
