import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart, LineChart } from "./charts/Chart";
import {
  bucketLabel,
  bucketPeriod,
  completePeriods,
  describeSeries,
  formatHoursMinutes,
  tableDate,
  SERIES,
  staleMessage,
} from "./progression";

const series = (id: string) => SERIES.find((s) => s.id === id)!;

describe("libellés de période", () => {
  it("raccourcit l'axe et détaille la période", () => {
    expect(bucketLabel("2026-10-26", "week")).toBe("26 oct.");
    expect(bucketLabel("2026-10-01", "month")).toBe("oct.");
    expect(bucketLabel("2027-01-01", "month")).toBe("2027");
    expect(bucketPeriod("2026-12-28", "week")).toBe("semaine du 28 déc. 2026");
    expect(bucketPeriod("2026-10-01", "month")).toBe("octobre 2026");
    expect(tableDate("2026-11-02", "week")).toBe("02/11/2026");
    expect(tableDate("2026-11-01", "month")).toBe("nov. 2026");
  });
});

describe("describeSeries", () => {
  it("résume dernière valeur, moyenne et tendance", () => {
    expect(describeSeries(series("distance"), [20_000, 30_000, 40_000])).toBe(
      "Dernière période complète : 40 km · moyenne : 30 km · tendance : en hausse.",
    );
  });

  it("dit d'une allure qui baisse qu'elle est plus rapide", () => {
    expect(describeSeries(series("pace"), [330, null, 300])).toContain(
      "tendance : plus rapide",
    );
  });

  it("signale l'absence de données", () => {
    expect(describeSeries(series("vdot"), [null])).toBe(
      "Aucune donnée sur la période.",
    );
  });

  it("écarte la période en cours, sauf si elle est seule", () => {
    expect(completePeriods([1, 2, 3])).toEqual([1, 2]);
    expect(completePeriods([3])).toEqual([3]);
  });
});

describe("formatHoursMinutes", () => {
  it("arrondit à la minute", () => {
    expect(formatHoursMinutes(13_453)).toBe("3 h 44");
    expect(formatHoursMinutes(0)).toBe("0 h 00");
  });
});

describe("staleMessage", () => {
  it("invite à réimporter avec la date de la dernière course importée", () => {
    expect(staleMessage("2026-09-12T07:00:00Z", true)).toContain(
      "s'arrête au 12 septembre 2026",
    );
    expect(staleMessage(null, true)).toContain("importe ton historique");
    expect(staleMessage("2026-11-01T07:00:00Z", false)).toBeNull();
  });
});

describe("graphiques SVG", () => {
  const points = [
    { label: "a", detail: "semaine A", value: 300 },
    { label: "b", detail: "semaine B", value: null },
    { label: "c", detail: "semaine C", value: 310 },
    { label: "d", detail: "semaine D", value: 290 },
  ];
  const props = {
    title: "Allure",
    points,
    format: String,
    summary: "Résumé accessible.",
  };

  it("expose une image décrite, le résumé et la valeur de la dernière période", () => {
    const html = renderToStaticMarkup(createElement(BarChart, props));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Allure. Résumé accessible."');
    expect(html).toContain("semaine D : 290");
    expect(html).toContain('tabindex="0"');
    expect(html.match(/<rect/g)).toHaveLength(3); // pas de barre pour le trou
  });

  it("coupe la ligne sur une période sans donnée", () => {
    const html = renderToStaticMarkup(createElement(LineChart, props));
    expect(html.match(/<polyline/g)).toHaveLength(1); // C–D
    expect(html).toMatch(/class="chart-dot"/); // A, point isolé
  });
});
