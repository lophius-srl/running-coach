// Lecture des séances de la montre (watch_activities, ADR 0005) pour les calculs et l'affichage :
// requête et type partagés par goals/fitness (niveau, plan), progression et activities (« Ma
// semaine »). Sans I/O ni type D1 : aussi importable par le front (types de la carte).

import type { WatchRunSample } from "../../core/watch-merge";

// Mesures de la séance, plus celles affichées sur la carte de « Ma semaine ».
export type WatchRow = WatchRunSample & {
  elapsedTimeS: number;
  maxHeartrate: number | null;
};

// Paramètres : user_id, début de période (ISO). Même préfiltre large que l'historique importé ;
// les séances qui ne sont pas des courses sont écartées par mergeWatchRuns.
export const WATCH_RUNS = `
  SELECT id, start_date AS startDate, sport_type AS sportType, distance_m AS distanceM,
    moving_time_s AS movingTimeS, elapsed_time_s AS elapsedTimeS,
    elevation_gain_m AS elevationGainM, average_heartrate AS averageHeartrate,
    max_heartrate AS maxHeartrate
  FROM watch_activities WHERE user_id = ? AND start_date >= ?`;
