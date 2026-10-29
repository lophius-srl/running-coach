# 0003 — Conformité Strava, coaching déterministe et synchronisation

- **Date** : 2026-10-29
- **Statut** : accepté

## Contexte
La politique API Strava (https://www.strava.com/legal/api_policy, en vigueur depuis le 2026-06-01) impose :
- **§5.3** : interdiction d'utiliser les données Strava « en lien avec le développement, l'entraînement,
  l'évaluation ou le fonctionnement de toute application d'IA » (seule exception : le MCP Strava officiel).
- **§6.2** : pas de données Strava en cache plus de **7 jours**.
- **§5.5** : pas de stockage des données Strava, ni des données qui en sont dérivées, dans un « Persistent Index ».
- **§6.3** : suppression des données d'un utilisateur reflétée sous **48 h**.
- **§3.3a** : niveau Standard limité à 10 utilisateurs, « soumis à des conditions d'abonnement ».

Webhooks Strava : réponse `200` en moins de 2 s, un seul abonnement par application, événements
`activity` (create/update/delete) et `athlete` (désautorisation), 3 tentatives au maximum.

## Options étudiées
1. **Coaching 100 % déterministe sur les données Strava** ; un LLM éventuel ne voit jamais de données Strava.
   Conforme, simple, testable. Inconvénient : pas d'explications générées à partir des runs.
2. **LLM (API Claude) alimenté par les runs Strava** : interdit par §5.3.
3. **Import de fichiers FIT/GPX exportés par l'utilisateur** (export autorisé, §6.6) : hors API, donc
   historique long et LLM possibles, mais saisie manuelle. Gardé comme évolution possible.

## Décision
Option 1.
- **Coaching** : règles déterministes (VMA estimée, allures, charge aiguë/chronique) en code testé.
  Un LLM, s'il est ajouté, ne reçoit que des données saisies par l'utilisateur (objectifs, contraintes)
  et des plans générés, **jamais** de données Strava ni de données qui en sont dérivées.
- **Modèle de données** :
  - *Durable* : données saisies par l'utilisateur (objectifs, course cible, chrono visé, disponibilités),
    plans/séances générés, tokens OAuth.
  - *Éphémère (≤ 7 jours)* : activités Strava brutes, avec une colonne `fetched_at` ; purge quotidienne.
  - *Agrégats dérivés* (ex. VMA estimée, charge hebdomadaire) : **point ouvert**, voir plus bas. En attendant,
    ils sont recalculés à la demande ou purgés avec les données sources.
- **Synchronisation** : webhook Strava (`POST /api/strava/webhook`, accusé de réception immédiat puis
  traitement via `ctx.waitUntil`) + un Cron Trigger quotidien qui fait (a) un rattrapage des activités
  récentes, (b) la purge des données Strava de plus de 7 jours. La désautorisation (`athlete`, `authorized=false`)
  supprime immédiatement les tokens et les données Strava.
- **Quota API** (~200 requêtes / 15 min, 2 000 / jour selon la presse, chiffres officiels sur le portail
  développeur) : largement suffisant pour un athlète ; pas d'import massif d'historique.

## Conséquences
- Pas d'historique Strava au-delà de 7 jours : les tendances longues dépendent de la décision sur les agrégats.
- Toute fonctionnalité qui enverrait des données Strava à un LLM doit être refusée en review.
- **Points ouverts** :
  - Conserver des agrégats dérivés (VMA, charge, records) est-il compatible avec §5.5 et §6.2 ? À valider
    juridiquement (ou en écrivant au support développeur Strava) avant de les persister.
  - Les « conditions d'abonnement » du niveau Standard (§3.3a) et un éventuel accès payant : à surveiller.
  - Cette lecture de la politique n'est pas un avis juridique.
