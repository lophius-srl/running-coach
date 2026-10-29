# CLAUDE.md — Règles du projet

> Ce fichier est lu automatiquement par Claude Code (en local et dans GitHub Actions).
> Complète les sections marquées `TODO` au démarrage de chaque nouveau projet.

## Le projet
- **Nom** : running-coach
- **But** : app web personnelle (un seul utilisateur au départ) pour suivre sa progression en course à pied
  à partir de ses données Strava, et recevoir des séances adaptées à ses objectifs (course cible, chrono).
- **Stack** : TypeScript, pnpm. Un seul Worker **Cloudflare** : API **Hono** + front **React/Vite** (assets
  statiques), base **D1** (SQLite), tests **Vitest**, ESLint + Prettier, déploiement `wrangler deploy` (ADR 0002).
- **Règles Strava (ADR 0003, non négociables)** : coaching **déterministe** ; **aucune donnée Strava (ni dérivée)
  envoyée à un LLM** ; données Strava purgées après **7 jours** ; ne stocker durablement que les données saisies
  par l'utilisateur (objectifs, plans générés) et les tokens OAuth.
- **Décisions d'architecture** : voir `docs/adr/`

## Commandes (toujours passer par le Makefile)
| Action | Commande |
|---|---|
| Installer | `make install` |
| Lancer en local | `make dev` |
| Lint / format | `make lint` / `make format` |
| Tests | `make test` |
| Build | `make build` |

La CI exécute exactement `make lint test build`. Si ça passe en local, ça passe en CI.

## Méthode de travail (obligatoire)
1. **Une issue = une branche = une PR.** Branche : `feat/<n°-issue>-court-titre`, `fix/<n°>-...`, `chore/...`.
2. **Jamais de commit direct sur `main`.**
3. **Commits conventionnels** : `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`.
   `feat!:` ou `BREAKING CHANGE:` pour une rupture. (Le changelog et les versions en dépendent.)
4. **Petites PR** : viser moins de ~400 lignes modifiées. Sinon, découper l'issue.
5. Chaque PR contient `Closes #<n°>` pour que la carte avance seule dans GitHub Projects.
6. **Tests** : toute nouvelle logique a des tests. Un bug corrigé = un test qui le reproduit.
7. Avant d'ouvrir une PR : `make lint test build` doit passer.

## Conventions de code
- Noms explicites, fonctions courtes, pas de code mort ni de `console.log`/`print` de debug.
- Pas de secrets dans le code : variables d'environnement + `.env.example` tenu à jour.
- Toute décision technique structurante → un ADR dans `docs/adr/`.
- Structure :
  - `src/worker/` : Worker Hono (routes HTTP, webhook Strava, cron). Routes API sous `/api/*`, plus `/health`.
  - `src/web/` : front React (point d'entrée `main.tsx`, page `index.html` à la racine).
  - `src/core/` (à venir) : logique de coaching pure (VMA, allures, charge), sans I/O, testée unitairement.
  - Tests à côté du code : `fichier.test.ts`.
- TypeScript `strict` ; pas de `any` ; modules ES ; un `tsconfig.json` par dossier (`src/worker`, `src/web`).
- Style imposé par Prettier (config par défaut) et ESLint (`typescript-eslint`, `react-hooks`) : `make format`.
- Code Worker compatible runtime Cloudflare (pas d'API Node-only) ; garder chaque requête sous 10 ms de CPU.
- Secrets locaux dans `.dev.vars` (modèle `.dev.vars.example`) ; en production, `wrangler secret put`.
- Dépendances : versions épinglées exactes dans `package.json`, mises à jour via Dependabot.

## Équipe d'agents (`.claude/agents/`)
| Agent | Rôle | Quand l'appeler |
|---|---|---|
| `product-owner` | Découpe une idée en issues avec critères d'acceptation | Nouvelle fonctionnalité |
| `architect` | Choix techniques, ADR, structure | Démarrage, choix structurant |
| `developer` | Implémente une issue, ouvre la PR | Une issue prête (`status: ready`) |
| `qa` | Écrit/complète les tests, cherche les cas limites | Avant ou pendant la PR |
| `reviewer` | Relit une PR selon la checklist | PR ouverte |

Le **propriétaire humain** du repo reste le lead : il valide les issues, relit et merge les PR.
Un agent ne merge jamais une PR et ne modifie jamais la CI ni les règles de branche sans demande explicite.
