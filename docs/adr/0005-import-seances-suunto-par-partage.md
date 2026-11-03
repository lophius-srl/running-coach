# 0005 — Import des séances Suunto (FIT) par partage depuis le téléphone

- **Date** : 2026-11-03
- **Statut** : accepté (2026-11-03, par le propriétaire). Priorité à l'iPhone : le parcours Android
  (PWA et Web Share Target, issue D) est reporté.

## Contexte
Le propriétaire court avec une montre Suunto. Il veut garder **toutes** ses séances sans limite de durée,
ce que l'API Strava interdit (7 jours, ADR 0003). L'import de `activities.csv` (ADR 0004) est manuel et
ne couvre que la période allant jusqu'au dernier export. Entre ce dernier export et les 7 jours de l'API,
il manque des séances.

L'app Suunto exporte chaque séance en **FIT**. C'est le format le plus complet : horodatage, FC, puissance,
cadence. Le menu « ⋯ » d'une séance permet d'enregistrer le fichier ou de l'**ouvrir dans une autre app**,
c'est-à-dire la feuille de partage du système. Le but : envoyer une séance à l'app **en 2 ou 3 gestes**,
**gratuitement**, **sans nom de domaine**, depuis un **iPhone comme depuis un Android**. Le fichier doit
arriver au Worker existant (`running-coach.dawn-frog-3fd3.workers.dev`).

Ce sont des **données fournies par l'utilisateur, issues de sa montre**, et non obtenues par l'API Strava.
Comme pour l'ADR 0004, elles relèvent du régime durable.

Contraintes :
- un seul Worker et D1 (ADR 0002) ;
- **10 ms de CPU par invocation** en offre gratuite ;
- migrations additives et compatibles N-1 ;
- une seule personne pour maintenir ;
- pas de domaine : `*.workers.dev` ne reçoit pas d'e-mails.

Faits vérifiés le 2026-11-03 (voir les sources) :
- **Raccourcis iOS** (app Apple gratuite)
  - Un raccourci peut apparaître dans la **feuille de partage** et y recevoir des **fichiers** (type
    d'entrée « Fichiers »).
  - L'action « Obtenir le contenu de l'URL » accepte les méthodes POST et PUT, des **en-têtes**
    personnalisés et un corps JSON, formulaire ou **fichier**.
  - La réponse JSON se lit comme un dictionnaire, qu'on peut afficher dans une notification.
- **Web Share Target** (manifeste `share_target`)
  - Pris en charge par Chrome sur Android depuis la version 76.
  - Pour recevoir des fichiers, il faut `method: "POST"`, `enctype: "multipart/form-data"` et une
    entrée `files` qui liste les types MIME **et** les extensions.
  - L'app doit être **installée** (PWA) : manifeste avec `name`, `icons` en 192 et 512 px, `start_url`,
    `display` autre que `browser`, HTTPS, et **service worker avec un gestionnaire `fetch`**.
  - La page ne lit pas le POST elle-même : le **service worker** l'intercepte.
  - **Safari iOS ne prend pas en charge `share_target`** (bug WebKit 194593, toujours ouvert).
- **Google** (Drive, Gmail)
  - Tant qu'un projet OAuth est « en test », ses jetons de rafraîchissement **expirent au bout de
    7 jours**.
  - `drive.file` est un scope non sensible, mais il ne voit que les fichiers créés ou ouverts par l'app.
  - `drive.readonly` est un scope **restreint** : vérification lourde, audit de sécurité annuel selon
    une source tierce.
  - Lire Gmail relève aussi des scopes restreints.
- **Cloudflare Email Routing** : il exige un domaine dont Cloudflare est le DNS faisant autorité. Les MX
  pointent vers `route{1,2,3}.mx.cloudflare.net`.
- **intervals.icu** : partenaire API Suunto, avec une synchronisation automatique des activités.
- **R2 (offre gratuite)** : chaque mois, 10 Go-mois de stockage Standard, 1 M d'opérations de classe A
  et 10 M de classe B, sortie gratuite.
- **Workers** :
  - offre gratuite : 10 ms de CPU par invocation (l'attente réseau, D1 et R2 ne comptent pas), 128 Mo de
    mémoire, script de 3 Mo compressés, corps de requête jusqu'à 100 Mo ;
  - Workers Paid (5 $/mois) : 30 s de CPU par défaut.

## Options étudiées
1. **Canal d'envoi**
   - **A. Partage vers l'app** :
     - iPhone : un Raccourci iOS dans la feuille de partage fait un POST du fichier vers l'API, avec un
       **jeton personnel** ;
     - Android : la PWA installée sert de **Web Share Target** ;
     - repli universel : un bouton « Importer un fichier FIT » dans l'onglet Import.

     Avantages : gratuit, sans domaine ni tiers, 2 ou 3 gestes (⋯ → Partager → « Envoyer à Running
     Coach »).

     Inconvénients : deux mécanismes, un par plateforme, et un jeton à gérer. Il faut aussi rendre l'app
     installable (manifeste, icônes, service worker minimal). **Retenu.**
   - **B. Dossier Google Drive lu par l'API Drive** :
     - il faut un projet Google Cloud et un second OAuth ;
     - en mode test, l'utilisateur doit se reconnecter **tous les 7 jours** ;
     - publier le projet impose une vérification, et `drive.readonly` est restreint ;
     - `drive.file` ne voit pas un fichier déposé par l'app Suunto ou par l'app Drive.

     Le tout demande aussi un cron de scrutation et ajoute un fournisseur. Rejeté.
   - **C. intervals.icu** :
     - automatique, sans geste, gratuit pour l'usage de base ;
     - mais un **service tiers** de plus : il faudrait un compte, et soit une seconde intégration API
       avec ses propres conditions, soit un export manuel depuis intervals.icu.

     On le garde comme alternative si le partage manuel devient pénible (nouvel ADR). Rejeté pour le MVP.
   - **D. E-mail vers une adresse gratuite** (ex. Gmail + API Gmail) : mêmes contraintes OAuth que B,
     avec des scopes Gmail restreints. Rejeté.
   - **E. E-mail vers un Cloudflare Email Worker** : élégant, mais il **exige un domaine** sur Cloudflare.
     Le propriétaire n'en a pas et n'en veut pas. Rejeté.
2. **Authentification du Raccourci** (il n'a pas le cookie de session)
   - *Jeton dans l'URL* (`?token=`) : il fuit dans les journaux, l'historique et les captures. Rejeté.
   - *Jeton personnel en en-tête* `Authorization: Bearer` : il est généré dans l'app, stocké **haché**,
     révocable. **Retenu.**
3. **Format de la requête**
   - *Multipart* : « Formulaire » côté Raccourci, et c'est le seul format possible pour `share_target`.
   - *Corps binaire* : « Fichier » côté Raccourci.
   - L'endpoint accepte **les deux** :
     - le multipart est lu par `Request.formData()`, natif dans `workerd`, avec un champ `file` ;
     - le binaire est lu par `arrayBuffer()`.

     **Aucune dépendance de parsing** n'est nécessaire.
4. **Où lire le FIT**
   - *Dans le navigateur* : seul le bouton manuel en dispose, et il faudrait deux chemins de traitement.
   - *Dans le Worker* : chemin unique pour les trois canaux. **Retenu.**
5. **Lecture du FIT**
   - *SDK officiel `@garmin/fitsdk`* :
     - avantages : version 21.218.0, ESM, aucune dépendance, API `ArrayBuffer` (compatible Workers a priori) ;
     - inconvénients : licence propriétaire Garmin (gratuite, mais pas une licence libre) ; `profile.js`
       pèse à lui seul ~1 Mo non minifié ; il décode **tous** les messages, avec une allocation par
       `record`, ce qui est un risque réel pour 10 ms de CPU.
   - *`fit-file-parser`* : licence MIT, mais pensé pour Node (polyfill `buffer`).
   - *Décodeur minimal maison* (`src/core/fit.ts`, environ 150 à 200 lignes) :
     - il lit l'en-tête (12 ou 14 octets, signature `.FIT`), les messages de définition (y compris la
       taille des champs développeur), les en-têtes normaux et à horodatage compressé, et le CRC final ;
     - il décode seulement `file_id` (0), `sport` (12) et `session` (18) ;
     - il **saute les autres messages** grâce à leur taille connue.

     Le coût est d'environ une lecture d'octet par message, sans allocation. **Retenu.**
6. **Profondeur de lecture**
   - *`record` seconde par seconde*, ou `lap` : CPU et stockage plus élevés, pour des fonctions (zones,
     splits) qui n'existent pas encore.
   - *Résumé `session`* (distance, temps chronométré et écoulé, D+, FC moyenne et max, sport) : il suffit
     à tous les calculs actuels (`fitness`, `progression`, `plan`). **Retenu**, avec le FIT brut conservé
     pour plus tard.
7. **Stockage**
   - *Colonne `source` dans `imported_activities`* :
     - la clé `(user_id, id)` repose sur l'Activity ID Strava, absent du FIT ;
     - l'upsert de l'ADR 0004 suppose le CSV ;
     - il faudrait migrer une clé primaire.

     Rejeté.
   - *Table dédiée `watch_activities`* : clé propre, colonnes propres au FIT, suppression indépendante.
     **Retenu.**
   - *FIT brut en BLOB dans D1* : il gonfle la base, plafonnée à 500 Mo. Rejeté.
   - *FIT brut dans R2* : une séance pèse environ 300 Ko ; 300 séances par an font environ 90 Mo, loin
     des 10 Go gratuits. **Retenu**, sous réserve du point ouvert sur l'activation de R2.
8. **Retour à l'utilisateur**
   - *Raccourci* : une notification avec le champ `message` de la réponse JSON.
   - *Share target et bouton* : une redirection vers l'onglet Import, qui affiche le résultat.
   - *Partout* : une liste « Derniers imports ». **Retenu.**

## Décision
Option **A**. On ajoute un endpoint unique `POST /api/imports/fit`, authentifié par la **session** (PWA,
bouton) **ou** par un **jeton personnel** `Bearer` (Raccourci iOS). Il reçoit un FIT en multipart ou en
binaire et le lit dans le Worker avec un **décodeur minimal maison** (résumé `session`). Il conserve le
fichier brut dans **R2** et stocke la séance **durablement** dans une nouvelle table D1 `watch_activities`.
L'affichage et les calculs **fusionnent** la séance montre avec la même sortie Strava. La version
**montre prime** pour les mesures.

### Parcours utilisateur
- **iPhone** (2 ou 3 gestes) :
  1. Dans l'app Suunto, ouvrir la séance → ⋯ → Exporter / Partager en FIT.
  2. Dans la feuille de partage, choisir « Envoyer à Running Coach ».
  3. Une notification affiche « Séance du 3 nov. importée : 10,2 km en 52:10 ».
- **Installer le Raccourci** (une seule fois) :
  - il se compose de deux actions : « Obtenir le contenu de l'URL » (POST, en-tête `Authorization`,
    corps « Fichier » = entrée du raccourci), puis « Afficher la notification » (valeur `message` du
    dictionnaire) ;
  - il est décrit pas à pas dans `docs/raccourci-ios.md` ;
  - le jeton y est collé à la main. On ne distribue pas de lien iCloud contenant le jeton.
- **Android** (2 gestes) :
  1. Dans l'app Suunto, ouvrir la séance → ⋯ → Exporter / Partager en FIT.
  2. Dans la feuille de partage, choisir « Running Coach » (la PWA installée).

  L'onglet Import s'ouvre ensuite sur le résultat.
- **Repli** (toutes plateformes, et ordinateur) : le bouton « Importer un fichier FIT » de l'onglet Import.

### Endpoint `POST /api/imports/fit`
- **Authentification**
  - Le chemin s'ajoute aux exceptions du middleware de session (`PUBLIC_API_PATHS`), puis la route
    s'authentifie elle-même.
  - Avec un en-tête `Authorization: Bearer <jeton>` :
    - la route calcule le SHA-256 du jeton et cherche son empreinte dans `personal_tokens` ;
    - si la session est absente ou invalide, elle renvoie `401` ;
    - les deux modes donnent le même `userId`.
- **Taille**
  - Refus `413` si `Content-Length` dépasse **4 MiB**, puis contrôle à nouveau après lecture.
  - Un FIT de 1 h pèse environ 100 à 300 Ko. 4 MiB couvrent largement un ultra enregistré à 1 Hz.
- **Type de contenu**
  - Sont acceptés `multipart/form-data` (champ `file`), `application/octet-stream`,
    `application/vnd.ant.fit` et un type absent. Tout autre type renvoie `415`.
  - L'extension et le type MIME **ne font pas foi** : seule compte la signature `.FIT` (octets 8 à 11),
    plus le CRC.
  - Un seul fichier par requête.
- **Idempotence**
  - On calcule le SHA-256 du fichier (`crypto.subtle.digest`, natif).
  - `UNIQUE (user_id, fit_sha256)` : un renvoi répond `200` avec le statut `duplicate`.
  - `UNIQUE (user_id, start_date)` : une ré-exportation aux octets différents **remplace** la séance.
- **Limitation de débit** : **30 imports par jour** et par utilisateur, comptés dans `watch_imports`, au-delà
  `429`. Le jeton fait 256 bits : le deviner par force brute n'est pas réaliste.
- **Réponse JSON**, lisible par le Raccourci :

  ```json
  {
    "status": "imported",
    "message": "Séance du 3 nov. 2026 importée : 10,2 km en 52:10",
    "activity": { "startDate": "…", "sportType": "Run", "distanceM": 10200, "movingTimeS": 3130 }
  }
  ```

- **Statuts et codes HTTP**

  | Statut | HTTP | Cas |
  | --- | --- | --- |
  | `imported` | 200 | séance enregistrée |
  | `duplicate` | 200 | fichier déjà importé |
  | `not_fit` | 400 | pas de signature FIT |
  | `invalid` | 400 | CRC ou structure invalide, pas de `session` |
  | `quota` | 429 | plus de 30 imports dans la journée |
  | — | 401 | authentification refusée |
  | — | 413 | fichier trop gros |
  | — | 415 | type de contenu refusé |

  - Chaque `message` est en français, prêt à afficher.
  - Les requêtes authentifiées sont journalisées dans `watch_imports`.
- **Pas de logs de données** : aucun `console.*`, ni jeton, ni mesure dans les journaux. Les exceptions
  sont réduites à un statut avant de remonter. L'observabilité est activée dans `wrangler.json`.

### Jeton personnel
- **Génération** : `POST /api/personal-token` (session requise) produit 32 octets aléatoires
  (`crypto.getRandomValues`), encodés en base64url avec le préfixe `rc_`.
  - Le jeton est **affiché une seule fois**, avec un bouton « Copier ».
  - D1 n'en stocke que le **SHA-256** : un jeton aléatoire de 256 bits n'a pas besoin d'un hachage lent.
- **Révocation et regénération**
  - Un seul jeton actif par utilisateur. En regénérer un remplace l'ancien.
  - `DELETE /api/personal-token` le révoque.
  - L'app affiche la date de création et de dernière utilisation, jamais le jeton.
- **Portée** : le jeton n'autorise **que** `POST /api/imports/fit`. Le reste de l'API exige la session.
- **Tests** : comparaison par empreinte, jeton révoqué refusé, jeton d'un autre utilisateur sans effet.

### PWA et Web Share Target (Android)
- **Fichier `public/manifest.webmanifest`** :
  - `name`, `start_url: "/"`, `display: "standalone"`, icônes en 192 et 512 px ;
  - `share_target` :

    ```json
    {
      "action": "/share-target",
      "method": "POST",
      "enctype": "multipart/form-data",
      "params": {
        "files": [
          { "name": "file", "accept": [".fit", "application/vnd.ant.fit", "application/octet-stream"] }
        ]
      }
    }
    ```

- **Fichier `public/sw.js`**, minimal et **sans mise en cache**, pour ne jamais servir de vieux assets :
  - il intercepte seulement `POST /share-target` ;
  - il renvoie le fichier à `/api/imports/fit` par `fetch` sur la même origine (le cookie de session part
    avec la requête) ;
  - il redirige vers l'onglet Import avec le statut en paramètre ;
  - toute autre requête passe au réseau.
- **Type MIME** : celui qu'envoie l'app Suunto sur Android est à vérifier sur l'appareil. Au besoin,
  élargir `accept`.

### CPU
Le parsing multipart est natif et le décodeur ne lit que les petits messages.

- **Estimation** (à confirmer dans l'issue B) :
  - séance de 1 h à 1 Hz : environ 3 600 `record` de 25 à 45 octets, soit 100 à 250 Ko ;
  - décodeur minimal (environ 4 000 sauts de message) : moins de 1 ms ;
  - SHA-256 natif : négligeable ;
  - D1 et R2 sont des I/O, hors CPU ;
  - total visé : **moins de 5 ms**.
- **Critère** : relever le « CPU time » dans l'observabilité sur un vrai FIT de 1 h et un de 3 h.
- **Si un jour on lit les `record`** : le faire dans le navigateur, à partir du FIT brut dans R2, ou
  passer à Workers Paid sur décision du propriétaire.

### Stockage
- **R2** : bucket `running-coach-fit`, liaison `FIT_BUCKET`. Clé : `fit/<user_id>/<sha256>.fit`.
  - Le fichier est écrit **avant** la ligne D1. Comme la clé est le hash, une écriture orpheline est
    réécrite à l'identique au prochain envoi.
  - Le FIT brut reste une donnée de l'utilisateur. Il est durable et suit la même suppression que sa
    ligne D1.
- **D1** : migration additive `migrations/0006_watch_activities.sql`, compatible N-1 (nouvelles tables,
  rien de modifié) :

```sql
-- Séances importées par l'utilisateur depuis sa montre (FIT partagé, ADR 0005).
-- Tables DURABLES : jamais purgées par le cron ; jamais envoyées à un LLM ; aucune donnée API Strava.
CREATE TABLE watch_activities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  fit_sha256 TEXT NOT NULL, -- hex ; clé d'idempotence et nom de l'objet R2
  start_date TEXT NOT NULL, -- ISO 8601 UTC (session.start_time)
  sport_type TEXT NOT NULL, -- vocabulaire Strava (Run, TrailRun, VirtualRun, Ride…)
  device TEXT, -- fabricant/produit lus dans file_id, ex. « suunto »
  distance_m REAL NOT NULL CHECK (distance_m >= 0),
  moving_time_s INTEGER NOT NULL CHECK (moving_time_s >= 0), -- session.total_timer_time
  elapsed_time_s INTEGER NOT NULL CHECK (elapsed_time_s >= 0),
  elevation_gain_m REAL CHECK (elevation_gain_m >= 0),
  average_heartrate REAL CHECK (average_heartrate > 0),
  max_heartrate REAL CHECK (max_heartrate > 0),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, fit_sha256),
  UNIQUE (user_id, start_date) -- sert aussi d'index pour les lectures par période
);

-- Journal des envois authentifiés : « Derniers imports » et quota quotidien.
CREATE TABLE watch_imports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL CHECK (status IN ('imported', 'duplicate', 'not_fit', 'invalid', 'quota')),
  activity_id INTEGER REFERENCES watch_activities (id) ON DELETE SET NULL
);

CREATE INDEX watch_imports_user_received_idx ON watch_imports (user_id, received_at);

-- Jeton personnel (Raccourci iOS) : empreinte SHA-256 seulement, un jeton actif par utilisateur.
CREATE TABLE personal_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);
```

- **Sport** : il est converti dans le vocabulaire Strava déjà utilisé par `RUN_TYPES`, pour que
  `src/core/` fonctionne sans changement.
  - `running` donne `Run`. Avec le sous-sport `trail`, on obtient `TrailRun`. Avec `treadmill` ou
    `virtual_activity`, on obtient `VirtualRun`.
  - `cycling` → `Ride`, `walking` → `Walk`, `hiking` → `Hike`, `swimming` → `Swim`.
  - Tout autre sport → `Workout`.
- **Séances qui ne sont pas des courses** : elles sont **stockées** (le but est de tout garder) et
  ignorées par les calculs grâce au filtre `RUN_TYPES`.
- **Écriture** : un seul `db.batch()` (upsert de la séance, puis insertion du journal). On reste dans les
  limites D1.
- **Volume** : environ 300 séances par an, soit moins de 100 Ko par an dans D1 et environ 90 Mo par an
  dans R2.
- **Suppression** : l'issue #37 (« Supprimer mon historique importé ») efface **aussi**
  `watch_activities`, `watch_imports` et les objets R2 sous `fit/<user_id>/`. Pour R2 : on liste les
  objets, puis on les supprime par lots de 1 000 clés au plus.
  - La suppression du compte efface les lignes D1 par cascade, jeton compris. Elle doit aussi vider le
    préfixe R2, qui n'a pas de clé étrangère : ce cas est couvert par le même code et testé.

### Déduplication avec Strava
Une même sortie peut arriver par trois sources : l'API (`strava_activities`, 7 jours), `activities.csv`
(`imported_activities`) et le FIT (`watch_activities`). Elles n'ont aucun identifiant commun.

- **Fonction de fusion** : une nouvelle fonction pure dans `src/core/` (ex. `mergeWatchRuns`) s'applique
  **après** `mergeRuns`, qui reste inchangée (fusion par id Strava, l'API l'emporte sur le CSV).
- **Règle de rapprochement** : même utilisateur, écart d'heure de départ **≤ 5 min**, et écart de distance
  **≤ 5 %**, ou **≤ 200 m** pour les sorties courtes.
  - En cas d'ambiguïté, on retient le départ le plus proche, et chaque séance n'est utilisée qu'une fois.
  - L'algorithme parcourt les deux listes triées par date : coût en O(n + m).
- **Priorité des sources**, pour l'affichage comme pour les calculs (`fitness`, `plan`, `progression`) :
  - les **mesures** (départ, distance, temps, D+, FC) viennent de la **montre**, la source d'origine,
    durable et plus précise ;
  - le **nom** et l'**id** viennent de Strava quand la sortie est rapprochée (le FIT n'a pas de titre) ;
  - le nom Strava vient du CSV, durable, ou de l'API, qui reste soumise aux 7 jours.
- **Séance montre sans équivalent Strava** : elle reçoit l'id `-watch_activities.id`. Les ids Strava sont
  positifs, donc il n'y a pas de collision avec `RunSample.id`. Cette convention est documentée et testée.
- **Temps** : `moving_time_s` (montre) vient du temps chronométré (pauses exclues). Le `moving_time` de
  Strava est calculé d'après la vitesse : de petits écarts sont attendus et acceptés.
- **Effet de bord positif** : le trou entre le dernier export CSV et les 7 jours de l'API (ADR 0004) se
  comble au fil des envois, de façon conforme.

### Conformité
- Aucune de ces données ne vient de l'**API Strava** : le FIT sort de la montre via l'app Suunto. Les
  tables `watch_*` et R2 relèvent du régime **durable**, et la purge à 7 jours ne les touche pas.
- **Aucun LLM** : le choix de l'ADR 0004 (« LLM : jamais ») s'applique aussi aux séances montre et à la
  vue fusionnée, qui contient des noms Strava. Revenir sur ce point demande un nouvel ADR.
- Le coaching reste **déterministe** (`src/core/`).
- À l'acceptation de cet ADR :
  - l'ADR 0003 sera amendé par un lien vers le présent ADR, comme pour l'ADR 0004 ;
  - la règle Strava de `CLAUDE.md` (stockage durable) sera complétée par le propriétaire.

### Découpage en issues (chacune < ~400 lignes)
- **A. Jeton personnel**
  - migration `personal_tokens` ;
  - `POST` et `DELETE /api/personal-token` ;
  - section « Envoi depuis le téléphone » dans l'onglet Import : générer, copier une fois, révoquer,
    date de dernière utilisation ;
  - critères : seule l'empreinte est stockée, le jeton n'est affiché qu'une fois, un jeton révoqué est
    refusé, tests de route.
- **B. Décodeur FIT minimal**
  - `src/core/fit.ts`, pur : en-tête, définitions, champs développeur, horodatage compressé, CRC,
    `file_id`, `sport` et `session`, conversion du sport ;
  - critères :
    - tests sur des fixtures **synthétiques** générées dans les tests ;
    - une fixture réelle Suunto **sans GPS** (tapis ou séance en salle) fournie par le propriétaire ;
    - fichiers tronqués, CRC faux, sans `session`, multisport (on retient la première `session` de
      course, sinon la première).
- **C. Endpoint `POST /api/imports/fit`**
  - migration `watch_activities` et `watch_imports` ;
  - liaison R2 `FIT_BUCKET` ;
  - authentification par session ou jeton ;
  - multipart et binaire, limites 413 et 415, idempotence, quota 429 ;
  - réponse JSON avec un `message` en français ;
  - bouton « Importer un fichier FIT » ;
  - `docs/raccourci-ios.md` ;
  - critères :
    - tests de route pour chaque statut ;
    - aucun `console.*` ;
    - CPU relevé en production sur un FIT de 1 h et un de 3 h, et noté dans la PR ;
    - Raccourci testé de bout en bout sur l'iPhone du propriétaire.
- **D. PWA installable et Web Share Target (Android)**
  - manifeste, icônes, `sw.js` sans cache ;
  - redirection vers l'onglet Import avec le statut ;
  - critères :
    - l'app est installable dans Chrome Android ;
    - « Running Coach » apparaît dans la feuille de partage de l'app Suunto ;
    - aucun asset n'est servi depuis un cache du service worker.
- **E. Fusion montre ↔ Strava et « Derniers imports »**
  - `mergeWatchRuns` dans `src/core/`, branchée dans `goals/fitness.ts`, `progression/routes.ts` et
    `/api/activities` ;
  - `GET /api/imports/fit` (20 dernières lignes de `watch_imports`) et la liste dans l'onglet Import ;
  - extension de #37 à `watch_*` et R2 ;
  - critères : tests de rapprochement (tolérances aux bornes, ambiguïté, sortie absente de Strava,
    séance non-course ignorée, priorité des champs) et suppression vérifiée dans D1 et R2.

  Si cette issue dépasse ~400 lignes, la découper en deux : fusion d'un côté, liste et suppression de
  l'autre.

## Conséquences
- **Ce que ça débloque**
  - Un historique **complet et durable**, alimenté au fil de l'eau et indépendant des 7 jours de l'API.
  - Des mesures plus fidèles : temps chronométré et FC max de la montre.
  - Une base (FIT brut dans R2) pour les zones, les splits et les meilleurs efforts.
  - L'app devient installable sur l'écran d'accueil.
- **Ce que ça coûte**
  - **0 €** et **aucune nouvelle dépendance npm**.
  - Un produit Cloudflare de plus (R2).
  - Un décodeur binaire maison à maintenir.
  - Un service worker et un manifeste.
  - Un jeton à garder secret.
  - Deux parcours à documenter, un par plateforme.
  - Un geste manuel par séance.
- **À surveiller**
  - Le CPU réel de l'endpoint.
  - Les limites gratuites de R2 et de Workers, qui changent souvent.
  - Les évolutions du format FIT, de l'app Suunto (menu de partage, type MIME) et des Raccourcis iOS.
  - Une éventuelle prise en charge de `share_target` par Safari.
- **Risques**
  - **Fuite du jeton** : sa portée est limitée à l'import, avec un quota et une révocation en un clic.
  - **Faux rapprochements** : tolérances testées et ajustables.
  - **Service worker défaillant** : sans cache, il est simple à désinstaller.
  - **Lecture juridique** : « FIT exporté par l'utilisateur = donnée de l'utilisateur ». Ce n'est pas un
    avis juridique.
- **En review, on refuse**
  - tout code qui écrit des données API Strava dans `watch_*` ou R2 ;
  - toute purge de ces données par le cron ;
  - tout envoi à un LLM ;
  - tout jeton accepté dans l'URL ou écrit en clair en base ;
  - tout log contenant un jeton ou des mesures ;
  - tout service worker qui met des assets en cache.

### Points ouverts (à trancher par le propriétaire)
1. **R2** : accepter de l'activer ? Vérifier si Cloudflare exige un moyen de paiement enregistré, même
   pour l'offre gratuite. Sans R2, le MVP marche sans conserver le FIT brut, et il faudra renvoyer les
   fichiers pour toute exploitation future (zones, splits).
2. **Tolérances de rapprochement** (5 min, 5 % ou 200 m) et **priorité** montre > Strava pour les mesures.
3. **Séances non-course** : les stocker (proposé) ou les refuser.
4. **Vérifications sur les téléphones** :
   - sur iPhone, l'export FIT de l'app Suunto passe-t-il bien par la feuille de partage ?
   - sur Android, quel type MIME l'app Suunto déclare-t-elle ?
   - quels appareils le propriétaire utilise-t-il réellement ? Si c'est seulement un iPhone, l'issue D
     peut attendre.
5. **intervals.icu** : en garder l'idée pour plus tard, si le geste manuel devient pénible ?
6. **Workers Paid (5 $/mois)** : seulement si une future lecture des `record` côté Worker le justifie.

## Sources
Consultées le 2026-11-03 par moteur de recherche : `developers.cloudflare.com` n'était pas joignable
directement depuis l'environnement de rédaction. À relire avant l'implémentation.
- Raccourcis iOS, entrée depuis la feuille de partage : https://support.apple.com/guide/shortcuts/apd7644168e1/ios
- « Obtenir le contenu de l'URL » (méthodes, en-têtes, corps fichier) : https://sixcolors.com/?p=11641 ;
  exemple de raccourci de partage vers une API : https://gist.github.com/andrewdolphin/a7dff49505e588d940bec55132fab8ad
- Web Share Target : https://developer.chrome.com/docs/capabilities/web-apis/web-share-target et
  https://developer.mozilla.org/docs/Web/Manifest/Reference/share_target
- Critères d'installation d'une PWA : https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
  et https://web.dev/articles/install-criteria
- Pas de `share_target` dans Safari iOS : https://bugs.webkit.org/show_bug.cgi?id=194593 et
  https://web-platform-dx.github.io/web-features-explorer/features/app-share-targets
- Expiration à 7 jours des jetons OAuth Google en mode test : https://developers.google.com/google-ads/api/docs/get-started/common-errors
  et https://developers.google.com/health/setup
- Scopes Drive (`drive.file` non sensible, `drive.readonly` restreint) : https://developers.google.com/drive/about-auth
  et https://developers.google.com/docs/api/auth
- Email Routing (domaine requis, MX Cloudflare) : https://developers.cloudflare.com/email-routing et
  https://developers.cloudflare.com/email-service/configuration/domains/
- intervals.icu et Suunto : https://www.intervals.icu/integrations/ et https://forum.intervals.icu/t/intervals-icu-and-suunto/5601
- Tarifs R2 : https://developers.cloudflare.com/r2/pricing/
- Limites Workers : https://developers.cloudflare.com/workers/platform/limits/
- SDK FIT JavaScript de Garmin : https://github.com/garmin/fit-javascript-sdk (npm `@garmin/fitsdk`
  21.218.0, aucune dépendance, licence FIT de Garmin, `profile.js` d'environ 1 Mo : vérifié dans
  l'archive npm) ; `fit-file-parser` 6.2.7 dépend de `buffer` (`npm view`)
- Protocole FIT : https://developer.garmin.com/fit/articles/fit-protocol/fit_protocol.html
- Export FIT dans l'app Suunto : https://www.suunto.com/Support/faq-articles/suunto-app/what-type-of-files-can-i-export-from-the-suunto-app/
