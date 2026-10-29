# 0002 — Stack et hébergement : TypeScript sur Cloudflare Workers + D1

- **Date** : 2026-10-29
- **Statut** : accepté

## Contexte
Application web personnelle (un seul utilisateur au départ) de suivi et de coaching course à pied,
alimentée par l'API Strava. Contraintes : hébergement gratuit, une seule personne pour maintenir,
réception possible des webhooks Strava (réponse `200` exigée en moins de 2 s), tâches planifiées
(rattrapage, purge des données Strava à 7 jours — voir ADR 0003).

## Options étudiées
1. **TypeScript full-stack sur Cloudflare Workers + D1** : un seul fournisseur, pas de mise en veille
   (webhook fiable), cron intégré, un seul langage. Inconvénients : runtime Workers (pas tout Node),
   10 ms de CPU par requête en offre gratuite, D1 = SQLite (moins riche que Postgres).
2. **Python FastAPI + HTMX sur Render + Postgres Neon** : écosystème data Python confortable.
   Inconvénients : mise en veille après ~15 min (démarrage à froid de 30–60 s, incompatible avec le
   délai de 2 s des webhooks), cron payant sur Render (à déporter dans GitHub Actions), deux fournisseurs.

## Décision
Option 1 : **un seul Worker Cloudflare** qui sert l'API (**Hono**) et le front (**React + Vite**, en assets
statiques), base **D1**, tests **Vitest**, gestionnaire de paquets **pnpm**, déploiement `wrangler deploy`.

Limites de l'offre gratuite vérifiées le 2026-10-29 :
- Workers : 100 000 requêtes/jour, 10 ms de CPU par requête (l'attente réseau ne compte pas),
  50 sous-requêtes par invocation, 5 Cron Triggers par compte.
- D1 : 5 M lignes lues/jour, 100 000 lignes écrites/jour, 5 Go au total, 500 Mo par base,
  10 bases par compte, 50 requêtes par invocation (`db.batch()` compte pour une).

Secrets : `wrangler secret put` en production, `.dev.vars` en local (modèle : `.dev.vars.example`),
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` dans l'environnement GitHub `production` pour la CI.

Jeton `CLOUDFLARE_API_TOKEN` : jeton personnalisé limité au compte, avec les permissions
**Account › Workers Scripts › Edit** (`wrangler deploy`) et **Account › D1 › Edit**
(`wrangler d1 migrations apply DB --remote`, lancé par `deploy.yml` avant le déploiement).
Le modèle « Edit Cloudflare Workers » ne donne pas forcément D1 › Edit : l'ajouter à la main.

## Conséquences
- Pas de dépendance Node-only côté Worker (vérifier la compatibilité runtime de chaque librairie).
- Les calculs lourds (streams GPS) doivent rester légers ou être découpés pour tenir dans 10 ms de CPU.
- La base D1 et les Cron Triggers seront ajoutés dans `wrangler.json` par les issues qui en ont besoin
  (`wrangler d1 create running-coach`), pas dans le squelette.
- Si les quotas gratuits changent ou deviennent bloquants, réévaluer (plan Workers Paid à 5 $/mois).
