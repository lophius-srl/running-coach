# Dev Kit — projet perso, process pro

Template de démarrage pour développer des apps et web apps avec une équipe d'agents Claude Code,
une gestion de projet GitHub Projects, de la peer review et du CI/CD. Agnostique de la stack.

👉 **Commence par [GUIDE.md](GUIDE.md).**

## Contenu
```
CLAUDE.md                  Règles du projet lues par les agents
Makefile                   Commandes uniques (install, lint, test, build, deploy)
.claude/
  agents/                  product-owner, architect, developer, qa, reviewer
  commands/                /kickoff, /feature, /work, /review
  settings.json            Permissions des agents (pas de merge, pas de force-push)
.github/
  workflows/
    ci.yml                 Lint + tests + build sur chaque PR
    claude-review.yml      Review automatique des PR par Claude
    claude.yml             "@claude" dans les issues et les PR
    release.yml            Versions + changelog (release-please)
    deploy.yml             Déploiement après merge sur main
  ISSUE_TEMPLATE/          Fonctionnalité, bug, tâche technique
  pull_request_template.md
  CODEOWNERS
  dependabot.yml
docs/adr/                  Décisions d'architecture
scripts/setup-github.sh    Labels, protection de main, board GitHub Projects
```

> Ce README est à remplacer par celui de ton projet au moment du `/kickoff`.
