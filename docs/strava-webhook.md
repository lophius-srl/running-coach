# Webhook Strava : créer l'abonnement (manuel)

Le Worker reçoit les événements Strava sur `https://<domaine>/api/strava/webhook` (ADR 0003).
L'abonnement n'est pas géré par l'application : on le crée une fois, à la main. Strava n'accepte
qu'**un abonnement par application**.

## Prérequis
1. L'application est déployée, et `/health` répond.
2. Choisir un verify token aléatoire et l'enregistrer comme secret :
   ```sh
   openssl rand -hex 32
   pnpm exec wrangler secret put STRAVA_WEBHOOK_VERIFY_TOKEN
   ```
   En local, le mettre dans `.dev.vars` (modèle `.dev.vars.example`).

## Créer l'abonnement
Strava appelle aussitôt `GET /api/strava/webhook?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`.
Le Worker renvoie `{ "hub.challenge": "…" }` si le token est le bon, sinon 403.

```sh
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id="$STRAVA_CLIENT_ID" \
  -F client_secret="$STRAVA_CLIENT_SECRET" \
  -F callback_url="https://<domaine>/api/strava/webhook" \
  -F verify_token="$STRAVA_WEBHOOK_VERIFY_TOKEN"
```

La réponse contient l'id de l'abonnement (`{ "id": 123456 }`).

## Vérifier ou supprimer
```sh
# Voir l'abonnement en cours
curl -G https://www.strava.com/api/v3/push_subscriptions \
  -d client_id="$STRAVA_CLIENT_ID" -d client_secret="$STRAVA_CLIENT_SECRET"

# Le supprimer (par exemple pour changer d'URL ou de verify token)
curl -X DELETE "https://www.strava.com/api/v3/push_subscriptions/<id>?client_id=$STRAVA_CLIENT_ID&client_secret=$STRAVA_CLIENT_SECRET"
```

## Ce que fait le Worker
- Il répond `200` tout de suite, puis traite l'événement après la réponse (`waitUntil`).
- Il ignore, sans erreur, les événements d'un autre athlète que `OWNER_ATHLETE_ID` et les corps invalides.
- `activity` create/update : il relit l'activité dans l'API, puis la stocke si c'est une course
  commencée il y a moins de 7 jours, sinon il retire la copie locale.
- `activity` delete : il supprime la copie locale, sauf si l'API sert encore cette course (faux événement).
- `athlete` avec `authorized=false` : il supprime les tokens OAuth et toutes les activités Strava de
  l'utilisateur immédiatement, sans confirmation auprès de l'API (la suppression prime, ADR 0003 §6.3).
  Il conserve l'objectif, les plans et l'historique importé (ADR 0004).
