import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import {
  formatDistance,
  formatDuration,
  formatPace,
  formatStartDate,
} from "./format";

// Consignes de marque Strava (https://developers.strava.com/guidelines/) : lien « View on Strava »
// par activité et mention « Powered by Strava ». Le logo officiel pourra remplacer ce texte plus tard.
const STRAVA_ORANGE = "#FC5200";

const stravaLinkStyle = { color: STRAVA_ORANGE, fontWeight: 600 } as const;

// Texte lu par les lecteurs d'écran mais invisible à l'écran.
const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

const HEADING_ID = "recent-runs-title";

export function RecentRuns({ data }: { data: RecentRunsData }) {
  return (
    <section>
      <h2 id={HEADING_ID}>Mes runs des 7 derniers jours</h2>
      {data.runs.length === 0 ? (
        <p>
          Aucune course sur les 7 derniers jours. Lance une synchronisation ou
          va courir !
        </p>
      ) : (
        <>
          <p>
            Total 7 jours : {formatDistance(data.total.distanceM)} en{" "}
            {formatDuration(data.total.movingTimeS)} ({data.total.count}{" "}
            course(s))
          </p>
          <table aria-labelledby={HEADING_ID}>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Course</th>
                <th scope="col">Distance</th>
                <th scope="col">Durée</th>
                <th scope="col">Allure moyenne</th>
                <th scope="col">FC moyenne</th>
                <th scope="col">Strava</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id}>
                  <td>{formatStartDate(run.startDate)}</td>
                  <td>{run.name}</td>
                  <td>{formatDistance(run.distanceM)}</td>
                  <td>{formatDuration(run.movingTimeS)}</td>
                  <td>{formatPace(run.paceSPerKm)}</td>
                  <td>
                    {run.averageHeartrate === null
                      ? "–"
                      : `${Math.round(run.averageHeartrate)} bpm`}
                  </td>
                  <td>
                    <a
                      href={`https://www.strava.com/activities/${run.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={stravaLinkStyle}
                    >
                      View on Strava
                      <span style={visuallyHidden}>
                        {` : ${run.name || formatStartDate(run.startDate)} (nouvel onglet)`}
                      </span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p style={{ fontSize: "0.8em" }}>Powered by Strava</p>
    </section>
  );
}
