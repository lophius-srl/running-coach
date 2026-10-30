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

export function RecentRuns({ data }: { data: RecentRunsData }) {
  return (
    <section>
      <h2>Mes runs des 7 derniers jours</h2>
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
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Distance</th>
                <th>Durée</th>
                <th>Allure moyenne</th>
                <th>FC moyenne</th>
                <th>Strava</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id}>
                  <td title={run.name}>{formatStartDate(run.startDate)}</td>
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
