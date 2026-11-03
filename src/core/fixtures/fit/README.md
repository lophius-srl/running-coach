# Fixtures FIT (tests de `src/core/fit.ts`)

## `suunto-run-anonymized.fit`

Vraie séance de course enregistrée par une montre Suunto, fournie par le propriétaire. Elle sert de
référence pour le décodeur (résumé `session`) et de test de charge (5 963 `record` à sauter).

Avant d'être déposée, elle a été **anonymisée** :

- les 5 963 positions GPS des `record` (`position_lat` et `position_long`) ont été remplacées par la
  valeur invalide FIT `0x7FFFFFFF` ;
- on a vérifié qu'aucune position (`session`, `lap`) ni aucun numéro de série ne restait ;
- le CRC de fichier a été recalculé : il est valide.

Les tests l'importent en data URL base64 (`?inline`, voir `assetsInclude` dans `vitest.config.ts`).
`node:fs` ne voit pas le disque dans l'environnement `workerd` des tests.

## Ajouter une fixture

1. **Anonymiser d'abord, hors du dépôt.** Ne jamais commiter de coordonnées GPS ni de numéro de série.
   - Préférer une séance **sans GPS** (tapis, salle).
   - Sinon, mettre à `0x7FFFFFFF` (sint32 invalide) les champs de position : `record` 0 et 1,
     `session`/`lap` 3, 4 et les coins de la zone (`nec`/`swc`).
   - Mettre à 0 ou à la valeur invalide `serial_number` (`file_id` 3, `device_info` 3).
2. Recalculer le CRC de fichier (2 derniers octets, CRC-16 FIT sur l'en-tête et les données).
   `fitCrc` dans `src/core/fit.ts` fait ce calcul.
3. Relire le résultat avec un outil indépendant (ex. le SDK FIT officiel, hors du projet) :
   - le fichier est intègre ;
   - plus aucune position.
4. Déposer le fichier ici (`<marque>-<sport>-anonymized.fit`) et ajouter un test dans
   `src/core/fit.test.ts` avec les valeurs attendues relevées à l'étape 3.
