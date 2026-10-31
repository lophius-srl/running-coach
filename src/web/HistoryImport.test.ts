import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryImport } from "./HistoryImport";

function renderIdle(): string {
  return renderToStaticMarkup(createElement(HistoryImport));
}

describe("HistoryImport before any file", () => {
  it("explains how to get the Strava export", () => {
    expect(renderIdle()).toContain("Télécharger ou");
  });

  it("asks for activities.csv extracted from the .zip archive", () => {
    const html = renderIdle();
    expect(html).toContain("<code>activities.csv</code>");
    expect(html).toContain("pas le .zip");
  });

  it("offers a CSV file picker and no import button yet", () => {
    const html = renderIdle();
    expect(html).toContain('accept=".csv,text/csv"');
    expect(html).not.toContain("<button");
  });
});
