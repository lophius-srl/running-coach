# 0004 — Import par l'utilisateur de son historique (export de compte Strava)

- **Date** : 2026-10-30
- **Statut** : accepté

## Contexte
Le propriétaire veut suivre sa progression sur des mois ou des années. L'API Strava interdit de garder
ses données plus de 7 jours (ADR 0003, §6.2). Strava permet en revanche à chacun de télécharger
son propre compte (Settings → My Account → Download or Delete Your Account). On obtient alors une
archive `.zip` qui contient `activities.csv` (une ligne par activité) et un dossier `activities/`
(fichiers `.gpx`/`.fit`/`.tcx`, parfois gzippés). L'ADR 0003 citait déjà cet import (option 3) comme
une évolution possible. Contraintes : 10 ms de CPU par requête Worker, D1 gratuit (100 000 lignes
écrites par jour), une seule personne pour maintenir.

## Options étudiées
1. **Où parser**
   - *Dans le Worker (envoi de l'archive)* : impossible en 10 ms de CPU pour un zip de plusieurs centaines de Mo.
   - *Dans le navigateur, puis envoi de lignes résumées par lots* : le CPU coûteux reste côté client,
     et le Worker valide puis insère de petits lots. **Retenu.**
2. **Source à lire**
   - *`activities.csv` seul* : un seul fichier de quelques Mo, qui contient déjà tous les champs utiles
     (date, type, distance, temps, dénivelé, FC moyenne). Simple. **Retenu pour le MVP.**
   - *Fichiers GPX/FIT/TCX* : ils apportent les splits, les meilleurs efforts et la FC détaillée. Mais il
     faut trois formats, du gzip, du FIT binaire et des centaines de Mo en mémoire. **Hors périmètre.**
3. **Lecture du zip**
   - *Librairie de dézippage dans le navigateur (ex. `fflate`, sans dépendance)* : plus confortable, mais
     ajoute une dépendance et oblige à décompresser une grosse archive en mémoire.
   - *L'utilisateur dézippe et dépose `activities.csv`* : aucune dépendance, aucun souci de mémoire, et
     un bon message d'aide suffit. **Retenu.** `fflate` pourra être ajouté plus tard (version épinglée
     exacte, ADR dédié) si le dépôt du zip entier devient utile.
4. **Statut des données importées**
   - *Les mêler à `strava_activities` (colonne `source`)* : une seule requête d'affichage, mais une
     purge mal filtrée effacerait l'historique, et les deux régimes se mélangent.
   - *Table dédiée `imported_activities`* : séparation physique, et la purge ne touche jamais cette
     table. **Retenu.**

## Décision
L'utilisateur dépose `activities.csv` dans le navigateur. Le front ne garde que les courses et les
envoie résumées, par lots, à un endpoint qui les stocke **durablement** dans une table dédiée,
distincte des données API éphémères.

- **Statut** : ce sont des données que l'utilisateur fournit lui-même, à partir de l'export prévu par
  Strava (§6.6), et non des données obtenues par l'API. Elles sont donc stockées durablement, comme
  les objectifs. L'**ADR 0003 est amendé** par un lien vers le présent ADR : « les données importées
  par l'utilisateur (ADR 0004) relèvent du régime durable ; la purge à 7 jours ne s'applique qu'à
  `strava_activities` ».
- **Coaching** : il reste **déterministe** (`src/core/`).
- **LLM : jamais** (choix du propriétaire) : l'historique importé **n'est pas envoyé à un LLM**, ni ses
  données dérivées (VMA, charge). Ce n'est pas une donnée « saisie » au sens de l'ADR 0003, mais une
  copie de données Strava. Le coaching reste 100 % déterministe ; revenir sur ce choix demanderait un
  nouvel ADR et une vérification juridique.
- **Parsing (`src/core/history-csv.ts`, pur et testé)** :
  - Parseur CSV RFC 4180 maison (~50 lignes : guillemets, virgules et retours à la ligne dans les
    descriptions, BOM UTF-8). Pas de dépendance.
  - En-têtes trouvés par **nom normalisé** (casse, accents et espaces ignorés), avec une table
    d'alias anglais et français, jamais par position. Colonnes requises : `Activity ID`,
    `Activity Date`, `Activity Type`, `Distance`, `Moving Time` (ou `Elapsed Time` à défaut).
    Colonnes facultatives : `Activity Name`, `Elevation Gain`, `Average Heart Rate`.
  - Si une colonne requise manque, l'import est refusé avec ce message : « passer Strava en anglais
    puis refaire l'export ».
  - Certains en-têtes sont **en double** (`Distance` en km puis en m, `Elapsed Time`). La colonne à
    retenir et l'unité sont **à vérifier sur un vrai export** du propriétaire. Une fixture anonymisée
    sera versionnée pour les tests.
  - Contrôle de cohérence entre distance et temps (allure entre 2 et 20 min/km), sinon la ligne est rejetée.
  - Dates du type `Mar 14, 2021, 7:02:11 AM` (UTC), lues avec une table des mois, puis stockées en
    ISO 8601 UTC.
  - Les nombres acceptent `,` ou `.` comme séparateur décimal.
  - Les lignes illisibles sont ignorées et comptées. Le rapport affiché donne : importées, ignorées
    (non-courses) et rejetées (avec le motif).
  - Filtre des types : celui de `isRun` (`Run`, `TrailRun`, `VirtualRun`), plus les libellés
    localisés courants (`Course à pied`…).
- **Endpoint** : `POST /api/history/import` (session requise), corps
  `{ rows: [{ id, startDate, sportType, name, distanceM, movingTimeS, elevationGainM, averageHeartrate }] }`.
  - Lots de **200 lignes au plus** (≈ 30 Ko de JSON). Le Worker **revalide chaque ligne** (types,
    bornes, nom tronqué à 200 caractères) et refuse les lots trop gros (413).
  - Il écrit le lot en un seul `db.batch()` d'upserts, ce qui reste bien sous 10 ms de CPU, car
    l'attente de D1 ne compte pas.
  - Le front envoie les lots **l'un après l'autre**.
- **Déduplication et idempotence** :
  - La clé est `(user_id, id)`, où `id` est l'Activity ID Strava.
  - Un ré-import fait `ON CONFLICT DO UPDATE` : il prend en compte les corrections (nom, type) et
    n'insère aucun doublon.
  - À l'affichage, une fonction pure de `src/core/` fusionne les deux sources par `id`. La version
    API (plus fraîche) **l'emporte** pour les 7 derniers jours. Une activité supprimée sur Strava
    reste dans l'historique importé tant que l'utilisateur ne refait pas d'import ou ne supprime
    pas son historique.
- **Suppression à la demande** : `DELETE /api/history` efface tout l'historique importé de
  l'utilisateur, avec un bouton « Supprimer mon historique importé ». La suppression du compte
  efface aussi l'historique (`ON DELETE CASCADE`).

Migration additive `migrations/0003_imported_activities.sql`, compatible N-1 (ADR 0002) :

```sql
-- Table DURABLE : historique importé par l'utilisateur depuis son export Strava (ADR 0004).
-- Jamais purgée automatiquement ; jamais envoyée à un LLM.
CREATE TABLE imported_activities (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id INTEGER NOT NULL, -- Activity ID Strava
  start_date TEXT NOT NULL, -- ISO 8601 UTC
  sport_type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  distance_m REAL NOT NULL CHECK (distance_m >= 0),
  moving_time_s INTEGER NOT NULL CHECK (moving_time_s >= 0),
  elevation_gain_m REAL CHECK (elevation_gain_m >= 0),
  average_heartrate REAL CHECK (average_heartrate > 0),
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

CREATE INDEX imported_activities_user_date_idx ON imported_activities (user_id, start_date);
```

Volume : 10 ans de course à pied représentent environ 3 000 lignes de moins de 200 octets, soit moins
de 1 Mo. C'est négligeable face aux 500 Mo d'une base D1. Un import complet écrit environ 6 000 lignes
(table et index), loin de la limite de 100 000 par jour.

## Conséquences
- **Ce que ça débloque** : les tendances longues (volume hebdomadaire et mensuel, allure, FC), la VMA
  estimée et la charge calculées sur l'historique (issues #13/#14), et les records personnels. Les
  agrégats tirés de l'historique importé peuvent être persistés. Le point ouvert de l'ADR 0003 ne
  concerne plus que les agrégats tirés des données API.
- **Sans les fichiers GPX/FIT**, on n'a pas de meilleurs efforts par distance. La VMA reste estimée
  à partir de courses entières. On peut y revenir plus tard.
- **L'import est manuel** : l'historique n'est complet qu'à la date de l'export, et l'API couvre les
  7 derniers jours. Entre les deux, il manque des activités tant qu'on ne refait pas d'export, ce qui
  est accepté pour le MVP. Combler ce trou automatiquement est interdit : ce serait garder des
  données API au-delà de 7 jours.
- **Risques** :
  - Le format du CSV peut changer sans préavis (Strava ne le documente pas), d'où les en-têtes lus
    par nom, les tests sur fixture et les messages d'erreur explicites.
  - Les exports localisés sont mal connus.
  - Mauvaise interprétation des colonnes en double (unités).
  - La lecture juridique (données exportées = données de l'utilisateur) n'est pas un avis juridique.
- **En review**, on refuse :
  - tout code qui purge `imported_activities` via le cron ;
  - tout code qui écrit des données API dans `imported_activities` ;
  - tout code qui envoie l'une ou l'autre table à un LLM.
