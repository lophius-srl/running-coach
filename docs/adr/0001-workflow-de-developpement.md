# 0001 — Workflow de développement

- **Date** : 2026-10-28
- **Statut** : accepté

## Contexte
Projet personnel, développé par une personne assistée d'agents IA (Claude Code).
On veut la rigueur d'un vrai projet (traçabilité, relecture, tests, déploiement automatique) avec des outils gratuits.

## Décision
- **Code et gestion de projet** : GitHub (issues, GitHub Projects, Pull Requests).
- **Flux** : une issue → une branche → une PR → CI verte → review (agent + humain) → merge → déploiement automatique.
- **Commits conventionnels**, versions et changelog générés par release-please.
- **Agents** : product-owner, architect, developer, qa, reviewer (`.claude/agents/`).
  L'humain reste seul à merger.

## Conséquences
- Rien n'arrive sur `main` sans PR ni CI verte.
- Le board GitHub Projects reflète l'état réel du code, sans saisie manuelle.
- Les reviews automatiques consomment des minutes Actions et du quota d'abonnement Claude.
