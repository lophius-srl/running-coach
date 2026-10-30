// Depuis vitest 4, le stockage D1 n'est plus remis à zéro entre deux tests d'un même fichier :
// chaque test qui part d'une base vide appelle resetDatabase dans un beforeEach.

const INTERNAL_TABLE = /^(sqlite_|_cf_|d1_migrations$)/;

export async function resetDatabase(db: D1Database): Promise<void> {
  // Ordre de création inversé : les tables enfants sont vidées avant leurs parents.
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid DESC",
    )
    .all<{ name: string }>();
  const tables = results
    .map((table) => table.name)
    .filter((name) => !INTERNAL_TABLE.test(name));
  if (tables.length === 0) return;
  await db.batch(tables.map((name) => db.prepare(`DELETE FROM "${name}"`)));
}
