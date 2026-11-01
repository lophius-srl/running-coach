// Ids configurés (wrangler.json › vars ou secrets) : entier décimal, sinon null (fail closed).
export function parseConfiguredId(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : null;
}

// Sans OWNER_ATHLETE_ID valide, aucune connexion n'est possible et aucun événement n'est traité.
export function ownerAthleteId(raw: string | undefined): number | null {
  return parseConfiguredId(raw);
}
