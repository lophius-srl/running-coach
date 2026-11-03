// Réponse de POST /api/imports/fit (ADR 0005), partagée avec le front. `message` est en français,
// prêt à afficher tel quel (notification du Raccourci iOS, onglet Import).

// Statuts journalisés dans watch_imports (contrainte CHECK de la migration 0007).
export type LoggedImportStatus =
  "imported" | "duplicate" | "not_fit" | "invalid" | "quota";

// Refus sans statut journalisable (auth, taille, type) ou erreur du serveur : jamais journalisés.
export type RejectedImportStatus =
  "unauthorized" | "too_large" | "unsupported_type" | "error";

export type FitImportStatus = LoggedImportStatus | RejectedImportStatus;

export type ImportedActivity = {
  startDate: string; // ISO 8601 UTC
  sportType: string; // vocabulaire Strava (Run, TrailRun, Ride…)
  distanceM: number;
  movingTimeS: number;
};

export type FitImportResponse = {
  status: FitImportStatus;
  message: string;
  activity?: ImportedActivity;
};
