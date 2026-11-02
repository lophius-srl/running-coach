import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  RecentRun,
  RecentRuns as RecentRunsData,
} from "../worker/activities/recent";
import { RecentRuns } from "./RecentRuns";

function run(fields: Partial<RecentRun>): RecentRun {
  return {
    id: 1,
    name: "Footing",
    startDate: "2026-10-29T06:00:00Z",
    distanceM: 10000,
    movingTimeS: 3000,
    paceSPerKm: 300,
    averageHeartrate: null,
    elevationGainM: null,
    elevationPerKm: null,
    ...fields,
  };
}

function render(
  runs: RecentRun[],
  total: Partial<RecentRunsData["total"]> = {},
): string {
  const data: RecentRunsData = {
    runs,
    total: {
      count: runs.length,
      distanceM: 10000,
      movingTimeS: 3000,
      elevationGainM: null,
      elevationPerKm: null,
      ...total,
    },
  };
  return renderToStaticMarkup(createElement(RecentRuns, { data }));
}

// Le bloc D+ d'une ligne de run, sans les autres chiffres.
function runElevation(html: string): string {
  const match = /<div class="run-elevation">(.*?)<\/div>/.exec(html);
  if (!match) throw new Error("bloc D+ absent");
  return match[1];
}

describe("RecentRuns elevation gain of a run", () => {
  it("shows the elevation gain and its ratio", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })]);

    expect(runElevation(html)).toBe(
      '<dt class="visually-hidden">Dénivelé positif</dt><dd>245 m D+</dd><dd class="figure-ratio">29 m/km</dd>',
    );
  });

  it("shows a dash and no ratio when Strava has no elevation gain", () => {
    const elevation = runElevation(render([run({})]));

    expect(elevation).toContain("<dd>– D+</dd>");
    expect(elevation).not.toContain("figure-ratio");
  });

  it("shows a dashed ratio for a zero-distance run with elevation gain", () => {
    const elevation = runElevation(
      render([run({ distanceM: 0, elevationGainM: 4, elevationPerKm: null })]),
    );

    expect(elevation).toContain("<dd>4 m D+</dd>");
    expect(elevation).toContain('<dd class="figure-ratio">–</dd>');
  });

  it("names the elevation figure for screen readers", () => {
    expect(runElevation(render([run({})]))).toContain(
      '<dt class="visually-hidden">Dénivelé positif</dt>',
    );
  });
});

describe("RecentRuns elevation gain of the week", () => {
  it("shows the total elevation gain with the overall ratio below", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })], {
      elevationGainM: 245,
      elevationPerKm: 13,
    });

    expect(html).toContain(
      '<dt><abbr title="Dénivelé positif">D+</abbr></dt><dd>245 m</dd><dd class="figure-ratio">13 m/km</dd>',
    );
  });

  it("shows dashes when no run of the week has an elevation gain", () => {
    const html = render([run({})]);

    expect(html).toContain('<dd>–</dd><dd class="figure-ratio">–</dd>');
  });
});
