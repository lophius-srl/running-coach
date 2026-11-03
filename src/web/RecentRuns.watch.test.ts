// QA de l'issue #69 : carte « Ma semaine » d'une séance montre sans Strava, rendue à partir de la
// vraie fusion (summarizeRecentRuns), et non d'un objet fabriqué à la main.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  summarizeRecentRuns,
  type WatchRow,
} from "../worker/activities/recent";
import { RecentRuns } from "./RecentRuns";

const NOW_MS = Date.parse("2026-11-04T12:00:00.000Z");

const watchOnly: WatchRow = {
  id: 12,
  startDate: "2026-11-03T07:00:00.000Z",
  sportType: "Run",
  distanceM: 8000,
  movingTimeS: 2400,
  elapsedTimeS: 2400,
  elevationGainM: null,
  averageHeartrate: null,
  maxHeartrate: null,
};

const stravaPayload = JSON.stringify({
  id: 900,
  name: "Footing Strava",
  sport_type: "Run",
  start_date: "2026-11-01T07:00:00Z",
  distance: 10_000,
  moving_time: 3000,
  average_cadence: 85,
  kudos_count: 4,
});

function render(payloads: string[], watch: WatchRow[]) {
  const data = summarizeRecentRuns(payloads, NOW_MS, undefined, watch);
  return renderToStaticMarkup(createElement(RecentRuns, { data }));
}

describe("RecentRuns : carte d'une séance montre seule", () => {
  it("s'intitule « Séance Suunto », sans lien Strava", () => {
    const html = render([], [watchOnly]);
    expect(html).toContain("Séance Suunto");
    expect(html).not.toContain("strava.com/activities");
  });

  it("masque cadence, kudos, records et effort relatif absents de la montre", () => {
    const html = render([], [watchOnly]);
    for (const label of [
      "Cadence",
      "Kudos",
      "Records",
      "Succès",
      "Effort relatif",
    ]) {
      expect(html).not.toContain(label);
    }
  });

  it("garde le lien Strava et la cadence de la carte Strava voisine", () => {
    const html = render([stravaPayload], [watchOnly]);
    expect(html.match(/strava\.com\/activities\//g)).toHaveLength(1);
    expect(html).toContain("strava.com/activities/900");
    expect(html).toContain("170 pas/min");
    expect(html).toContain("Kudos");
  });
});
