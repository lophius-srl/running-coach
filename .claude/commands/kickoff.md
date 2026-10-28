---
description: Démarrer un nouveau projet (architecte + product owner)
argument-hint: <description du projet>
---

On démarre un nouveau projet : $ARGUMENTS

1. Agent `architect` : propose 2 options de stack au maximum (avec hébergement gratuit) et recommande-en une.
   Attends ma validation.
2. Une fois validée : ADR dans `docs/adr/`, sections `TODO` de `CLAUDE.md`, cibles du `Makefile`,
   installation des outils dans `.github/workflows/ci.yml`, cible de `deploy.yml`, écosystème dans `dependabot.yml`.
   Fais tout ça sur une branche `chore/kickoff` et ouvre une PR.
3. Agent `product-owner` : propose un backlog pour une première version minimale (MVP).
   Attends ma validation avant de créer les issues.
