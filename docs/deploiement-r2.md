# Déploiement : bucket R2 des fichiers FIT (prérequis de l'issue #68)

L'import des séances de la montre (ADR 0005) conserve chaque fichier FIT brut dans R2, sous
`fit/<user_id>/<sha256>.fit`. `wrangler.json` lie le bucket `running-coach-fit` au Worker sous le
nom `FIT_BUCKET`.

**Ordre : avant de merger la PR de l'issue #68, activer R2, puis
`pnpm exec wrangler r2 bucket create running-coach-fit`.** Le merge déclenche le déploiement, qui
échoue si le bucket n'existe pas. Étapes détaillées :

1. **Activer R2** sur le compte Cloudflare : tableau de bord → **R2 Object Storage** → accepter
   l'offre gratuite (10 Go-mois, 1 M d'opérations de classe A et 10 M de classe B par mois). Point
   ouvert de l'ADR 0005 : Cloudflare peut demander un moyen de paiement, même pour l'offre gratuite.
2. **Créer le bucket** depuis le poste du propriétaire (connecté par `wrangler login`) :

   ```sh
   pnpm exec wrangler r2 bucket create running-coach-fit
   pnpm exec wrangler r2 bucket list   # vérification
   ```

3. **Jeton de la CI (`CLOUDFLARE_API_TOKEN`)** : aucune permission nouvelle n'est **indispensable**
   si le bucket existe déjà. Comportement de `wrangler deploy` (wrangler 4.156.0, lu dans le code
   de `provision-bindings`) :
   - si la liaison n'est pas encore sur le Worker déployé, wrangler vérifie l'existence du bucket
     par l'API R2 ;
   - sans permission R2 (réponse 403), il affiche un avertissement (« Skipping automatic
     provisioning… ») et **continue** le déploiement ; celui-ci échoue seulement si le bucket
     n'existe pas ;
   - avec la permission **Account › Workers R2 Storage › Edit**, il crée lui-même le bucket s'il
     manque.

   Recommandé : ajouter **Account › Workers R2 Storage › Edit** au jeton (à côté de Workers
   Scripts › Edit et D1 › Edit, ADR 0002) pour supprimer l'avertissement. Aucune modification de
   `deploy.yml` n'est nécessaire.

## Si le bucket a été oublié
Le workflow Deploy échoue au `wrangler deploy`, **après** la migration 0007. Cette migration est
additive : l'ancien Worker continue de tourner normalement. Pour rattraper :
1. activer R2 et créer le bucket (étapes 1 et 2 ci-dessus) ;
2. relancer le déploiement à la main : GitHub → **Actions** → **Deploy** → **Run workflow** sur
   `main`. La migration déjà appliquée est ignorée.

En local, `wrangler dev` et les tests (`vitest-pool-workers`, `r2Buckets` dans
`vitest.config.ts`) simulent R2 sans compte ni réseau.

## Après le déploiement
- Relever le « CPU time » de `POST /api/imports/fit` dans l'observabilité, sur un FIT de 1 h et un
  de 3 h (critère de l'ADR 0005), et le noter dans la PR.
- Tester le Raccourci de bout en bout sur l'iPhone : [docs/raccourci-ios.md](raccourci-ios.md).
