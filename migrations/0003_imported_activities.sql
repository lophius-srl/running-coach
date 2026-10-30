-- Historique importé par l'utilisateur depuis l'export de son compte Strava (issue #35, ADR 0004).
-- Additive et compatible N-1 (ADR 0002) : nouvelle table, rien n'est modifié ni supprimé.
-- Table DURABLE : jamais purgée automatiquement ; jamais envoyée à un LLM.
CREATE TABLE imported_activities (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id INTEGER NOT NULL, -- Activity ID Strava
  start_date TEXT NOT NULL, -- ISO 8601 UTC
  sport_type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  distance_m REAL NOT NULL CHECK (distance_m >= 0),
  moving_time_s INTEGER NOT NULL CHECK (moving_time_s >= 0),
  elevation_gain_m REAL CHECK (elevation_gain_m >= 0),
  average_heartrate REAL CHECK (average_heartrate > 0),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

CREATE INDEX imported_activities_user_date_idx ON imported_activities (user_id, start_date);
