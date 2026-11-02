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
    sportType: "Run",
    surface: "road",
    workout: null,
    elapsedTimeS: null,
    pauseS: null,
    maxPaceSPerKm: null,
    maxHeartrate: null,
    cadenceSpm: null,
    elevLowM: null,
    elevHighM: null,
    sufferScore: null,
    prCount: null,
    achievementCount: null,
    kudosCount: null,
    paceZone: null,
    heartRateZone: null,
    metersPerBeat: null,
    vdot: null,
    weekShare: null,
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

// Le bloc D+ des chiffres clés d'une carte de run (dernier chiffre clé).
function runElevation(html: string): string {
  const match =
    /<dl class="key-figures run-key-figures">.*<div class="key-figure">(.*?)<\/div><\/dl>/.exec(
      html,
    );
  if (!match) throw new Error("bloc D+ absent");
  return match[1];
}

// Détails d'une carte, en titres de groupe (« # ») et paires « libellé : valeur ».
function runDetails(html: string): string[] {
  const start = html.indexOf('<section class="run-detail-group">');
  if (start === -1) return [];
  const pattern =
    /<h4 class="run-detail-title">(.*?)<\/h4>|<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g;
  return [...html.slice(start).matchAll(pattern)].map(
    ([, title, label, value]) => (title ? `# ${title}` : `${label} : ${value}`),
  );
}

describe("RecentRuns card of a run", () => {
  it("shows the start, the name, the type badges and the Strava link", () => {
    const html = render([
      run({ id: 42, name: "Piste", surface: "trail", workout: "intervals" }),
    ]);

    expect(html).toContain(
      '<time class="muted" dateTime="2026-10-29T06:00:00Z">',
    );
    expect(html).toContain('<h3 class="run-name">Piste</h3>');
    expect(html).toContain(
      '<li class="badge">Trail</li><li class="badge">Fractionné</li>',
    );
    expect(html).toContain('href="https://www.strava.com/activities/42"');
  });

  it("shows the four key figures", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })]);

    expect(html).toContain("<dt>Distance</dt><dd>10,00 km</dd>");
    expect(html).toContain("<dt>Durée</dt><dd>0:50:00</dd>");
    expect(html).toContain("<dt>Allure</dt><dd>5:00/km</dd>");
    expect(runElevation(html)).toContain("<dd>245 m</dd>");
  });

  it("lists every known detail, formatted", () => {
    const html = render([
      run({
        paceZone: "threshold",
        maxPaceSPerKm: 200,
        elapsedTimeS: 3210,
        pauseS: 210,
        averageHeartrate: 152.4,
        maxHeartrate: 181,
        heartRateZone: 3,
        metersPerBeat: 1.5234,
        cadenceSpm: 172,
        elevLowM: 112.4,
        elevHighM: 245.6,
        vdot: 47.26,
        sufferScore: 86.6,
        weekShare: 0.337,
        prCount: 2,
        achievementCount: 5,
        kudosCount: 0,
      }),
    ]);

    expect(runDetails(html)).toEqual([
      "# Allure et effort",
      "Zone d&#x27;allure : Seuil",
      "Allure max : 3:20/km",
      "Temps total : 0:53:30",
      "Pauses : 0:03:30",
      "VDOT : 47,3",
      "Effort relatif : 87",
      "# Cœur et foulée",
      "FC moyenne : 152 bpm",
      "FC max : 181 bpm",
      "Zone cardiaque : Z3 · Tempo",
      "Efficacité : 1,52 m/batt.",
      "Cadence : 172 pas/min",
      "# Terrain et semaine",
      "Altitude min – max : 112 – 246 m",
      "Part de la semaine : 34 %",
      "Records : 2",
      "Succès : 5",
      "Kudos : 0",
    ]);
  });

  it("hides unknown details, zero records and groups with nothing known", () => {
    expect(runDetails(render([run({ kudosCount: 3, prCount: 0 })]))).toEqual([
      "# Terrain et semaine",
      "Kudos : 3",
    ]);
    expect(render([run({})])).not.toContain("run-detail");
  });

  it("hides the altitude when only one bound is known", () => {
    expect(runDetails(render([run({ elevLowM: 10 })]))).toEqual([]);
  });
});

describe("RecentRuns elevation gain of a run", () => {
  it("shows the elevation gain with its ratio below", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })]);

    expect(runElevation(html)).toBe(
      '<dt>D+<span class="visually-hidden"> (dénivelé positif)</span></dt><dd>245 m</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">29 m/km</dd>',
    );
  });

  it("shows a dash and no ratio when Strava has no elevation gain", () => {
    const elevation = runElevation(render([run({})]));

    expect(elevation).toContain("<dd>–</dd>");
    expect(elevation).not.toContain("figure-ratio");
  });

  it("shows a dashed ratio for a zero-distance run with elevation gain", () => {
    const elevation = runElevation(
      render([run({ distanceM: 0, elevationGainM: 4, elevationPerKm: null })]),
    );

    expect(elevation).toContain("<dd>4 m</dd>");
    expect(elevation).toContain('<dd class="figure-ratio">–</dd>');
  });
});

describe("RecentRuns elevation gain of the week", () => {
  it("shows the total elevation gain with the overall ratio below", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })], {
      elevationGainM: 245,
      elevationPerKm: 13,
    });

    expect(html).toContain(
      '<dt>D+<span class="visually-hidden"> (dénivelé positif)</span></dt><dd>245 m</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">13 m/km</dd>',
    );
  });

  it("shows dashes when no run of the week has an elevation gain", () => {
    const html = render([run({})]);

    expect(html).toContain(
      '<dd>–</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">–</dd>',
    );
  });
});

describe("RecentRuns card labels (QA #60)", () => {
  it.each([
    ["road", null, "Route"],
    ["treadmill", "race", 'Tapis</li><li class="badge">Course'],
    ["road", "long", 'Route</li><li class="badge">Sortie longue'],
  ] as const)("shows the %s / %s badges", (surface, workout, badges) => {
    expect(render([run({ surface, workout })])).toContain(
      `<li class="badge">${badges}</li></ul>`,
    );
  });

  it.each([
    ["recovery", "Récupération"],
    ["endurance", "Endurance"],
    ["tempo", "Tempo"],
    ["above_threshold", "Entre seuil et VMA"],
    ["vma", "VMA"],
  ] as const)("names the %s pace zone %s", (paceZone, label) => {
    expect(runDetails(render([run({ paceZone })]))).toContain(
      `Zone d&#x27;allure : ${label}`,
    );
  });

  it.each([
    [1, "Z1 · Récupération"],
    [5, "Z5 · VMA"],
  ])("names heart rate zone %i %s", (heartRateZone, label) => {
    expect(runDetails(render([run({ heartRateZone })]))).toContain(
      `Zone cardiaque : ${label}`,
    );
  });

  it("shows a zero pause rather than hiding it", () => {
    expect(runDetails(render([run({ pauseS: 0 })]))).toContain(
      "Pauses : 0:00:00",
    );
  });

  it("hides zero achievements", () => {
    expect(runDetails(render([run({ achievementCount: 0 })]))).toEqual([]);
  });
});

describe("RecentRuns card name (QA #60)", () => {
  it("falls back on a default title for a blank name", () => {
    expect(render([run({ name: "   " })])).toContain(
      '<h3 class="run-name">Course sans titre</h3>',
    );
  });

  it("escapes special characters of the Strava name", () => {
    const html = render([run({ name: '<img src=x onerror="alert(1)">' })]);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });

  it("names the Strava link after the run for screen readers", () => {
    expect(render([run({ id: 7, name: "Footing" })])).toContain(
      '<span class="visually-hidden"> : Footing (nouvel onglet)</span>',
    );
  });
});

describe("RecentRuns card structure (QA #60)", () => {
  it("renders one list item, one article and one h3 per run", () => {
    const html = render([run({ id: 1 }), run({ id: 2, name: "Seuil" })]);

    expect(html.match(/<article class="card run-card">/g)).toHaveLength(2);
    expect(html.match(/<h3 class="run-name">/g)).toHaveLength(2);
    expect(html).toContain('<ul class="run-cards"><li><article');
  });

  it("titles each detail group with an h4 under the card heading", () => {
    const html = render([run({ kudosCount: 1, averageHeartrate: 150 })]);

    expect(html.match(/<h4 class="run-detail-title">/g)).toHaveLength(2);
  });

  it("keeps every detail pair inside a description list", () => {
    const html = render([run({ kudosCount: 1, maxHeartrate: 180 })]);

    for (const group of html.match(/<dl class="run-details">.*?<\/dl>/g) ??
      []) {
      expect(group).toMatch(
        /^<dl class="run-details">(<div><dt>[^<]+<\/dt><dd>[^<]+<\/dd><\/div>)+<\/dl>$/,
      );
    }
    expect(html).toContain('<dl class="run-details">');
  });
});
