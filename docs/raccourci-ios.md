# Raccourci iOS « Envoyer à Running Coach »

Ce Raccourci envoie une séance de ta montre Suunto à Running Coach depuis la feuille de partage de
l'iPhone, en 2 ou 3 gestes (ADR 0005). Il fait un `POST` du fichier FIT vers
`/api/imports/fit`, avec ton **jeton personnel**, puis affiche la réponse dans une notification.

> Intitulés des actions : ceux de l'app Raccourcis en français (iOS 17 et 18), indiqués de mémoire
> et à confirmer sur ton iPhone. Ils n'ont pas pu être revérifiés en ligne à la rédaction. Si un
> intitulé diffère, cherche l'action par son nom anglais, indiqué entre parenthèses.

## Avant de commencer
1. Ouvre Running Coach, onglet **Import**, section **Envoi depuis l'iPhone**.
2. Touche **Générer mon jeton**, puis **Copier**. Le jeton commence par `rc_`. Il ne sera plus
   affiché : colle-le dans le Raccourci dès l'étape 2.

Ne partage jamais ce Raccourci par un lien iCloud : il contient ton jeton.

## Créer le Raccourci (une seule fois)
1. **Nouveau raccourci.** Ouvre l'app **Raccourcis** et touche **+**. Nomme-le
   **Envoyer à Running Coach**.
   - Touche l'icône **ⓘ** (Détails), puis active **Afficher dans la feuille de partage**
     (*Show in Share Sheet*).
   - En haut du raccourci, le bloc « Reçoit … depuis Partager » apparaît. Touche les types
     proposés et ne garde que **Fichiers** (*Files*).
   - « Si aucune entrée » : choisis **Arrêter et répondre** (ou laisse **Continuer**).
2. **Action « Obtenir le contenu de l'URL »** (*Get Contents of URL*). Ajoute-la, puis :
   - **URL** : `https://running-coach.dawn-frog-3fd3.workers.dev/api/imports/fit`
   - Déplie les options (flèche **>** ou **Afficher plus**) :
     - **Méthode** : `POST`
     - **En-têtes** : touche **Ajouter un nouvel en-tête**.
       Clé : `Authorization`. Valeur : `Bearer`, **une espace**, puis ton jeton collé
       (ex. `Bearer rc_AbC…`). N'ajoute pas de guillemets.
     - **Corps de la requête** : **Fichier** (*File*). Dans le champ **Fichier**, choisis la
       variable **Entrée du raccourci** (*Shortcut Input*).
3. **Action « Obtenir la valeur du dictionnaire »** (*Get Dictionary Value*) :
   **Obtenir** `Valeur` pour la clé `message` dans **Contenu de l'URL**.
4. **Action « Afficher la notification »** (*Show Notification*) : touche le texte et choisis la
   variable **Valeur du dictionnaire**.
5. Touche **OK** pour enregistrer.

La réponse du serveur est toujours un JSON `{ "status", "message" }`, y compris en cas d'erreur :
la notification affiche donc aussi les refus (« Fichier trop gros… »).

Variante si l'envoi est refusé avec « Format d'envoi refusé » (415) : à l'étape 2, choisis
**Corps de la requête** : **Formulaire** (*Form*), ajoute un champ de type **Fichier**, clé `file`,
valeur **Entrée du raccourci**. Le serveur accepte les deux formats.

## Envoyer une séance
1. Dans l'app **Suunto**, ouvre la séance, touche **⋯**, puis **Exporter** / **Partager** au format
   **FIT** (l'intitulé varie selon la version de l'app).
2. Dans la feuille de partage, choisis **Envoyer à Running Coach**. Au premier envoi, iOS demande
   l'autorisation de contacter `running-coach.dawn-frog-3fd3.workers.dev` : touche **Toujours
   autoriser**.
3. La notification affiche par exemple « Séance du 23 oct. 2026 importée : 13,1 km en 1:44:05 ».

Renvoyer la même séance ne crée pas de doublon (« déjà importée »). Une nouvelle exportation de la
même séance remplace l'ancienne. Les séances qui ne sont pas des courses (vélo, marche…) sont
conservées, mais ignorées par les calculs.

## Dépannage
| Message ou code | Cause | Solution |
| --- | --- | --- |
| « jeton absent ou invalide » (401) | Jeton mal collé, révoqué ou **regénéré** depuis (l'ancien ne marche plus). | Regénère un jeton dans l'onglet Import et remplace la valeur de l'en-tête `Authorization` (`Bearer` + espace + jeton). |
| « Fichier trop gros » (413) | Fichier de plus de 1,5 Mo (séance de plus de 5 h environ). | Pas de contournement pour l'instant : signale-le. |
| « Format d'envoi refusé » (415) | Le Raccourci envoie un type de contenu inattendu. | Passe le corps en **Formulaire**, champ `file` (voir la variante). |
| « n'est pas un fichier FIT » (400) | Fichier **GPX** ou autre format : seul le FIT est pris en charge. | Dans l'app Suunto, choisis l'export **FIT**. |
| « Fichier FIT illisible » (400) | Fichier tronqué ou corrompu. | Exporte à nouveau la séance. |
| « Limite de 30 envois en 24 h » (429) | Trop d'envois en 24 h. | Réessaie plus tard. |
| Aucune notification, ou erreur « Obtenir la valeur du dictionnaire » | Pas de réseau, ou URL mal saisie. | Vérifie l'URL, puis réessaie. |

Le jeton n'ouvre que l'envoi de séances : il ne donne accès à aucune autre donnée. En cas de doute,
**Révoquer** dans l'onglet Import le désactive aussitôt.

## Données et conformité
Le fichier FIT vient de ta montre, pas de l'API Strava (ADR 0005). Il est conservé durablement
(fichier brut dans R2, résumé dans la base), n'est jamais purgé par la tâche quotidienne et n'est
jamais envoyé à un LLM.
