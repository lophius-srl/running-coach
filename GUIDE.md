# Guide de mise en place

Ce guide installe ton « studio de dev » perso : GitHub pour le code et la gestion de projet,
une équipe d'agents Claude Code, de la peer review et du CI/CD.
Compte environ **1 heure** pour la première installation, puis **5 minutes** par nouveau projet.

---

## Vue d'ensemble

```
 Idée ──/feature──▶ Issues (backlog) ──▶ Board GitHub Projects
                                             │
                     /work <n°>  ou  "@claude" dans l'issue
                                             ▼
             Branche ──▶ Code + tests ──▶ Pull Request
                                             │
          CI (lint, test, build) + review auto Claude + TA review
                                             ▼
             Merge (squash) ──▶ Déploiement auto ──▶ carte « Done »
                                             │
                     release-please ──▶ version + changelog
```

| Besoin | Outil | Coût |
|---|---|---|
| Code, issues, PR | GitHub | Gratuit |
| Gestion de projet | GitHub Projects (Kanban, roadmap, sprints) | Gratuit |
| CI/CD | GitHub Actions | Gratuit (illimité en public, quota mensuel en privé) |
| Sécurité | Dependabot, CodeQL | Gratuit (CodeQL : repos publics) |
| Agents IA | Claude Code | Ton abonnement Claude |
| Hébergement | Vercel, Netlify, Cloudflare Pages, Render, Supabase… | Offres gratuites |

> **Public ou privé ?** Sur le plan GitHub gratuit, la protection de branche (règle « PR et CI obligatoires »)
> et CodeQL ne sont disponibles que pour les **repos publics**. En privé, tu gardes tout le reste ;
> la discipline repose alors sur toi (et sur l'interdiction de merge donnée aux agents).
> Les étudiants peuvent obtenir GitHub Pro gratuitement avec le GitHub Student Pack.

---

## Étape 1 — Installer les outils (une seule fois)

1. **Git** et un compte **GitHub**.
2. **GitHub CLI** : https://cli.github.com, puis :
   ```bash
   gh auth login
   gh auth refresh -s project      # droit de gérer les boards GitHub Projects
   ```
3. **Claude Code** : suis l'installation officielle (https://docs.claude.com/en/docs/claude-code), puis lance `claude`
   et connecte-toi avec ton compte d'abonnement.

---

## Étape 2 — Faire du kit un « template repository » (une seule fois)

Comme ça, chaque nouveau projet démarre avec tout le kit en une commande.

```bash
cd dev-kit
git init -b main && git add . && git commit -m "chore: initial dev kit"
gh repo create dev-kit --private --source . --push
gh repo edit --template          # marque le repo comme template
```

---

## Étape 3 — Créer un nouveau projet

```bash
gh repo create mon-app --template <ton-user>/dev-kit --public --clone
cd mon-app
chmod +x scripts/setup-github.sh
./scripts/setup-github.sh
```

Le script configure :
- les **labels** (type, status, priority, size) ;
- le **merge en squash uniquement**, avec le titre de la PR comme message de commit, et la suppression des branches après merge ;
- la **protection de `main`** : PR obligatoire, CI verte obligatoire, conversations résolues ;
- un **board GitHub Projects** lié au repo, avec les champs Priority, Size et Sprint ;
- ton nom dans `CODEOWNERS` (à commiter ensuite via une PR).

---

## Étape 4 — Brancher Claude sur GitHub

Dans le dossier du projet, lance `claude` puis :

```
/install-github-app
```

Ça installe l'app GitHub Claude et enregistre le secret d'authentification.
Si tu préfères le faire à la main :
1. Installe l'app : https://github.com/apps/claude
2. Dans un terminal : `claude setup-token`, puis copie le jeton.
3. Sur GitHub : *Settings → Secrets and variables → Actions → New repository secret*, nom `CLAUDE_CODE_OAUTH_TOKEN`.

> Si `/install-github-app` propose d'ajouter ses propres fichiers `claude.yml` et `claude-code-review.yml`,
> refuse : le kit contient déjà les siens (en français, réservés au propriétaire du repo).

Tu obtiens alors :
- **Review automatique** de chaque PR (`claude-review.yml`) ;
- **`@claude`** dans une issue ou une PR pour lui confier une tâche (`claude.yml`).
  Seuls toi et tes collaborateurs pouvez le déclencher.

---

## Étape 5 — Configurer le board (5 minutes, dans l'interface web)

Ouvre le board (lien affiché par le script), puis :

1. **Colonnes** : dans le champ *Status*, crée `Backlog`, `Ready`, `In progress`, `In review`, `Done`.
2. **Vues** :
   - *Board* groupé par Status (le Kanban) ;
   - *Table* filtrée `label:"status: triage"` (ce qui reste à clarifier) ;
   - *Roadmap* sur le champ Sprint (les itérations).
3. **Automatisations** (menu `…` → *Workflows*), active :
   - *Auto-add to project* : filtre `is:issue,pr is:open` ;
   - *Item added to project* → Status = `Backlog` ;
   - *Pull request linked to issue* → `In review` (si proposé) ;
   - *Item closed* et *Pull request merged* → `Done`.

Grâce au `Closes #N` dans chaque PR, l'issue se ferme au merge et la carte passe en `Done` sans aucune action manuelle.

---

## Étape 6 — Sécurité et CD

1. *Settings → Code security* : active **Dependabot alerts**, **Dependabot security updates**,
   **Secret scanning** et, en public, **CodeQL** (configuration par défaut).
2. **Déploiement** : le plus simple est de connecter le repo directement à Vercel, Netlify ou Cloudflare Pages.
   Tu as alors un déploiement en production à chaque merge sur `main`, et une URL de preview pour chaque PR.
   Dans ce cas, supprime `.github/workflows/deploy.yml`.
   Pour un backend (Render, Railway…), utilise l'option « deploy hook » de `deploy.yml`.

---

## Étape 7 — Démarrer le projet avec les agents

Dans Claude Code, à la racine du projet :

```
/kickoff Une app web pour suivre mes plantes et me rappeler quand les arroser
```

- L'**architecte** propose 2 stacks, tu choisis, puis il remplit `CLAUDE.md`, le `Makefile`, la CI et Dependabot
  sur une branche, et ouvre une PR.
- Le **product owner** propose un backlog MVP. Tu valides, il crée les issues.

---

## Le cycle quotidien

| Tu veux… | Commande |
|---|---|
| Ajouter une fonctionnalité au backlog | `/feature <idée>` |
| Développer une issue (dev → qa → PR → review) | `/work 12` |
| Faire relire une PR en local | `/review 15` |
| Déléguer depuis GitHub, même sur mobile | commente `@claude implémente cette issue` |
| Demander une correction sur une PR | commente `@claude corrige le point 🔴 de la review` |
| Appeler un agent précis | « utilise l'agent qa pour… » |

**Ton rôle de lead** à chaque PR :
1. Lire la review de Claude et la description de la PR.
2. Tester la preview si c'est de l'UI.
3. Vérifier que la CI est verte.
4. **Squash and merge**. Le déploiement et la carte suivent tout seuls.

### Rituels « comme en équipe » (optionnels mais utiles)
- **Planning de sprint** (1 à 2 semaines) : choisis les issues `status: ready` et assigne-les au sprint courant.
- **Revue de sprint** : regarde ce qui est passé en `Done` et la dernière release.
- **Rétro** : note dans une issue `type: chore` ce que tu veux améliorer dans le process ou les agents.

### Versions et changelog
Chaque merge sur `main` met à jour une PR « chore: release » ouverte par release-please.
Quand tu veux publier une version, merge cette PR : version incrémentée, `CHANGELOG.md` à jour, release GitHub créée.

> Les PR ouvertes par un bot ne déclenchent pas la CI. Pour la PR de release, ferme-la puis rouvre-la :
> la CI se lance et tu peux merger.

---

## Personnaliser l'équipe

- Les agents sont de simples fichiers Markdown dans `.claude/agents/` : modifie leurs consignes librement.
- Ajoute un agent spécialisé si besoin (ex. `ux-designer`, `security`, `docs-writer`) : copie un fichier existant et adapte-le.
- Les commandes `/kickoff`, `/feature`, `/work` et `/review` sont dans `.claude/commands/`.
- `.claude/settings.json` autorise les commandes sans risque et **interdit** aux agents de merger, de forcer un push
  ou de lire `.env`.

## Garder le contrôle des coûts
- La review automatique tourne à l'ouverture d'une PR, pas à chaque push.
  Pour une nouvelle review après corrections : onglet *Actions* → *Claude Code Review* → *Run workflow*.
- Ouvre tes PR en **brouillon** (draft) tant qu'elles ne sont pas prêtes : aucune review n'est lancée.
- En privé, surveille le quota de minutes Actions dans *Settings → Billing*.

## Dépannage
| Problème | Solution |
|---|---|
| Le script ne crée pas le board | `gh auth refresh -s project`, puis relance le script (labels et règles sont idempotents) |
| « Impossible de protéger main » | Repo privé sur le plan gratuit : passe-le en public ou applique la discipline à la main |
| La PR est bloquée sur « checks » | La CI doit avoir tourné au moins une fois : pousse un commit sur la branche |
| La review Claude ne se lance pas | Vérifie le secret `CLAUDE_CODE_OAUTH_TOKEN` et que l'app Claude est installée sur le repo |
| `@claude` ne répond pas | Seuls OWNER, MEMBER et COLLABORATOR peuvent le déclencher ; vérifie l'onglet *Actions* |
