-- Objectif : chrono de référence et objectif unique par utilisateur (issue #13).
-- Additive et compatible N-1 (ADR 0002) : colonnes nullables, aucune suppression.
-- Données saisies par l'utilisateur : durables, non purgées (ADR 0003).

ALTER TABLE goals ADD COLUMN reference_distance_m INTEGER CHECK (reference_distance_m > 0);
ALTER TABLE goals ADD COLUMN reference_time_s INTEGER CHECK (reference_time_s > 0);

-- Un seul objectif actif par utilisateur : le remplacement se fait par upsert sur user_id,
-- qui garde l'id de la ligne (pas de DELETE, donc pas de cascade silencieuse sur plans).
CREATE UNIQUE INDEX goals_user_id_unique_idx ON goals (user_id);
