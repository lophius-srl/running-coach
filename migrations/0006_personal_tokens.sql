-- Jeton personnel du Raccourci iOS (issue #66, ADR 0005). Additive et compatible N-1 (ADR 0002) :
-- nouvelle table. Table DURABLE : seule l'empreinte SHA-256 (hex) du jeton est stockée, jamais le
-- jeton lui-même. Un jeton actif par utilisateur ; en regénérer un remplace l'ancien.
CREATE TABLE personal_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);
