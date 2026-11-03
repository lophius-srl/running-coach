-- Séances importées par l'utilisateur depuis sa montre (FIT partagé, issue #68, ADR 0005).
-- Additive et compatible N-1 (ADR 0002) : nouvelles tables, rien de modifié.
-- Tables DURABLES : jamais purgées par le cron ; jamais envoyées à un LLM ; aucune donnée API Strava.
CREATE TABLE watch_activities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  fit_sha256 TEXT NOT NULL, -- hex ; clé d'idempotence et nom de l'objet R2
  start_date TEXT NOT NULL, -- ISO 8601 UTC (session.start_time)
  sport_type TEXT NOT NULL, -- vocabulaire Strava (Run, TrailRun, VirtualRun, Ride…)
  device TEXT, -- fabricant/produit lus dans file_id, ex. « suunto »
  distance_m REAL NOT NULL CHECK (distance_m >= 0),
  moving_time_s INTEGER NOT NULL CHECK (moving_time_s >= 0), -- session.total_timer_time
  elapsed_time_s INTEGER NOT NULL CHECK (elapsed_time_s >= 0),
  elevation_gain_m REAL CHECK (elevation_gain_m >= 0),
  average_heartrate REAL CHECK (average_heartrate > 0),
  max_heartrate REAL CHECK (max_heartrate > 0),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, fit_sha256),
  UNIQUE (user_id, start_date) -- sert aussi d'index pour les lectures par période
);

-- Journal des envois authentifiés : « Derniers imports » et quota quotidien.
CREATE TABLE watch_imports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL CHECK (status IN ('imported', 'duplicate', 'not_fit', 'invalid', 'quota')),
  activity_id INTEGER REFERENCES watch_activities (id) ON DELETE SET NULL
);

CREATE INDEX watch_imports_user_received_idx ON watch_imports (user_id, received_at);
