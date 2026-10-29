-- Schéma initial (issue #9). Voir docs/adr/0003 pour la séparation durable / éphémère.

-- =====================================================================
-- Tables DURABLES : données saisies par l'utilisateur, plans générés,
-- tokens OAuth. Aucune donnée Strava ni donnée dérivée de Strava ici.
-- =====================================================================

-- Utilisateur de l'application, identifié par son id d'athlète Strava.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  strava_athlete_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Tokens OAuth Strava. Supprimés immédiatement à la désautorisation.
CREATE TABLE oauth_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- epoch en secondes
  scope TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Objectifs saisis par l'utilisateur : course cible, chrono visé, disponibilités.
CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  race_name TEXT,
  race_date TEXT NOT NULL, -- date ISO 8601 (AAAA-MM-JJ)
  distance_m INTEGER NOT NULL CHECK (distance_m > 0),
  target_time_s INTEGER CHECK (target_time_s > 0),
  available_days TEXT NOT NULL DEFAULT '[]', -- tableau JSON de jours ISO (1 = lundi … 7 = dimanche)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX goals_user_id_idx ON goals (user_id);

-- Plans d'entraînement générés pour un objectif.
CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX plans_goal_id_idx ON plans (goal_id);

-- Séances d'un plan.
CREATE TABLE plan_sessions (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL, -- date ISO 8601 (AAAA-MM-JJ)
  kind TEXT NOT NULL, -- ex. endurance, fractionné, sortie longue
  description TEXT NOT NULL DEFAULT ''
);

CREATE INDEX plan_sessions_plan_id_idx ON plan_sessions (plan_id);

-- =====================================================================
-- Tables ÉPHÉMÈRES (≤ 7 jours) : données Strava brutes.
-- `fetched_at` est obligatoire : la purge quotidienne s'appuie dessus.
-- =====================================================================

CREATE TABLE strava_activities (
  id INTEGER PRIMARY KEY, -- id de l'activité Strava
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  payload TEXT NOT NULL, -- JSON brut renvoyé par l'API Strava
  fetched_at TEXT NOT NULL -- horodatage ISO 8601 de la récupération
);

CREATE INDEX strava_activities_fetched_at_idx ON strava_activities (fetched_at);
CREATE INDEX strava_activities_user_id_idx ON strava_activities (user_id);
