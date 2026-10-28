---
description: Développer une issue de bout en bout (developer → qa → reviewer)
argument-hint: <numéro de l'issue>
---

Développe l'issue #$ARGUMENTS en enchaînant l'équipe :

1. Agent `developer` : branche, implémentation, commits, `make lint test build`.
2. Agent `qa` : vérifie la couverture des critères d'acceptation et ajoute les tests manquants.
3. Agent `developer` : ouvre la PR avec `Closes #$ARGUMENTS`.
4. Agent `reviewer` : relit la PR et me donne son verdict.

Arrête-toi après la review et résume : ce qui a été fait, le lien de la PR, les points 🔴/🟠 restants.
Ne merge pas la PR.
