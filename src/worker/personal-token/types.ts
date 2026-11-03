// Réponses de /api/personal-token, partagées avec le front (sans dépendance au runtime Worker).

export type PersonalTokenStatus = {
  exists: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
};

export type GeneratedPersonalToken = { token: string; createdAt: string };
