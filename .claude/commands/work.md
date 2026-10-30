---
description: Développer une issue de bout en bout (developer → qa → reviewer)
argument-hint: <numéro de l'issue>
---

Développe l'issue #$ARGUMENTS en enchaînant l'équipe :

1. Agent `developer` : branche, implémentation, commits, `make lint test build` — en local, sans push.
2. Agent `qa` : vérifie la couverture des critères d'acceptation et ajoute les tests manquants — en local.
3. Agent `reviewer` : relit le diff local (`git diff main...<branche>`) et donne son verdict ;
   le `developer` corrige les 🔴 en local.
4. Agent `developer` : un seul push, puis ouvre la PR avec `Closes #$ARGUMENTS` et une description complète.

Respecte la section « Interactions avec GitHub » de `CLAUDE.md` (pas de polling de la CI, pas de commentaire posté).

Arrête-toi après l'ouverture de la PR et résume : ce qui a été fait, le lien de la PR, les points 🔴/🟠 restants.
Ne merge pas la PR.
