// Types d'activité Strava considérés comme de la course à pied. Source unique, partagée par la
// synchro API (src/worker/sync) et l'import de l'export de compte (history-csv), sans I/O.
export const RUN_TYPES: ReadonlySet<string> = new Set([
  "Run",
  "TrailRun",
  "VirtualRun",
]);
