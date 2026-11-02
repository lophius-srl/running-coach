-- Zones cardiaques (issue #57). Additive et compatible N-1 (ADR 0002) : nouvelle table.
-- Table DURABLE : FC repos, FC max et zones sont saisies par l'utilisateur (ADR 0003), rien
-- ne vient de Strava. Une ligne par utilisateur, indépendante de l'objectif de course.
CREATE TABLE heart_rate_zones (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  resting_hr INTEGER NOT NULL CHECK (resting_hr BETWEEN 30 AND 120),
  max_hr INTEGER NOT NULL CHECK (max_hr BETWEEN 120 AND 230 AND max_hr > resting_hr),
  -- Tableau JSON des 5 zones (Z1 → Z5) : [{ "low": bpm, "high": bpm }, …], validé par l'API.
  zones TEXT NOT NULL CHECK (json_valid(zones) AND json_array_length(zones) = 5),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
