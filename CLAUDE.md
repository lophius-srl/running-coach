# CLAUDE.md — Règles du projet

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

## Commandes
Toujours passer par les cibles du `Makefile`. La CI exécute exactement `make lint test build`. Si ça passe en local, ça passe en CI.

## Interactions avec GitHub (sobriété, obligatoire)
Le compte a été suspendu une fois après une journée très automatisée. Pour rester un usage « humain » :
- **Local d'abord** : tout se vérifie avec `make lint test build` avant le premier push. Un push par étape
  (fin du dev, fin de la QA, corrections de review), jamais un push par commit.
- **Pas de PR brouillon pour faire tourner la CI** : la PR s'ouvre une seule fois, quand le travail est prêt.
- **Pas de surveillance en boucle** : interdit `gh pr checks --watch`, `gh run watch` et les boucles sur l'API.
  Vérifier la CI une seule fois, au moins 3 minutes après le push (`gh pr checks <n°>`), sinon laisser l'humain regarder.
- **Créations en petit nombre** : au plus 5 issues par session, une par une, avec ≥ 30 s entre deux créations.
  Pas de script de création en masse. Au-delà, préparer les fichiers et laisser l'humain les créer.
- **Pas de commentaire automatique** : les reviews et rapports se donnent dans le terminal. Poster sur GitHub
  (`gh pr comment`, `gh pr review`, `gh issue comment`) seulement si l'humain le demande, une fois.
- **Ne jamais écrire `@claude`, `@dependabot` ni `@<login>`** dans un texte publié (déclenche des workflows/notifications).
- **Lecture plutôt qu'écriture** : préférer `git` local (`git diff main...HEAD`, `git log`) à l'API GitHub quand c'est possible.
- Si GitHub répond 403/429 ou « suspended » : s'arrêter immédiatement et prévenir l'humain, sans réessayer.

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
- TypeScript `strict` ; pas de `any` ; modules ES ; un `tsconfig.json` par dossier (`src/worker`, `src/web`).
- Code Worker compatible runtime Cloudflare (pas d'API Node-only) ; garder chaque requête sous 10 ms de CPU.
- Secrets locaux dans `.dev.vars` (modèle `.dev.vars.example`) ; en production, `wrangler secret put`.
- Dépendances : versions épinglées exactes dans `package.json`, mises à jour via Dependabot.

## Équipe d'agents (`.claude/agents/`)
Le **propriétaire humain** du repo reste le lead : il valide les issues, relit et merge les PR.
Un agent ne merge jamais une PR et ne modifie jamais la CI ni les règles de branche sans demande explicite.
