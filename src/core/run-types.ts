// Types d'activité Strava considérés comme de la course à pied. Source unique, partagée par la
// synchro API (src/worker/sync) et l'import de l'export de compte (history-csv), sans I/O.
export const RUN_TYPES: ReadonlySet<string> = new Set([
  "Run",
  "TrailRun",
  "VirtualRun",
]);

// Vocabulaire Strava (`sport_type`) des séances importées d'un fichier FIT (ADR 0005).
export type StravaSportType =
  | "Run"
  | "TrailRun"
  | "VirtualRun"
  | "Ride"
  | "Walk"
  | "Hike"
  | "Swim"
  | "Workout";
