-- Plan de la semaine (issue #15). Additive et compatible N-1 (ADR 0002) : colonnes nullables.
-- Table DURABLE (plans générés, ADR 0003) : structure du plan seulement. Les allures cibles,
-- dérivées des activités Strava, ne sont pas stockées : elles sont recalculées à l'affichage.
ALTER TABLE plans ADD COLUMN week_start TEXT; -- AAAA-MM-JJ, premier jour couvert
ALTER TABLE plans ADD COLUMN phase TEXT; -- development, specific ou taper
ALTER TABLE plan_sessions ADD COLUMN duration_min INTEGER CHECK (duration_min > 0);
