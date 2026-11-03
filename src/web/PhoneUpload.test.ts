import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FreshToken, PhoneUpload, TokenPanel } from "./PhoneUpload";

const TOKEN = `rc_${"A".repeat(43)}`;

function panel(initial: Parameters<typeof TokenPanel>[0]["initial"]) {
  return renderToStaticMarkup(createElement(TokenPanel, { initial }));
}

describe("PhoneUpload", () => {
  it("announces the iPhone section and the upcoming Shortcut guide", () => {
    const html = renderToStaticMarkup(createElement(PhoneUpload));
    expect(html).toContain("Envoi depuis l&#x27;iPhone");
    expect(html).toContain("Le guide du Raccourci arrive bientôt");
    expect(html).toContain("Chargement du jeton");
  });
});

describe("TokenPanel", () => {
  it("offers to generate a token when none exists", () => {
    const html = panel({ exists: false, createdAt: null, lastUsedAt: null });
    expect(html).toContain("Générer mon jeton");
    expect(html).not.toContain("Révoquer");
    expect(html).not.toContain("<input");
  });

  it("shows the dates, never the token, and offers regenerate / revoke", () => {
    const html = panel({
      exists: true,
      createdAt: "2026-11-01T08:00:00.000Z",
      lastUsedAt: null,
    });
    expect(html).toContain("Créé le");
    expect(html).toContain("Dernière utilisation");
    expect(html).toContain("jamais");
    expect(html).toContain("Regénérer");
    expect(html).toContain("Révoquer");
    expect(html).not.toContain("<input");
  });
});

describe("FreshToken", () => {
  it("shows the token once, read-only, with a copy button and a warning", () => {
    const html = renderToStaticMarkup(
      createElement(FreshToken, { token: TOKEN }),
    );
    expect(html).toContain(`value="${TOKEN}"`);
    expect(html).toContain("readOnly");
    expect(html).toContain("Copier");
    expect(html).toContain("il ne sera plus affiché");
  });
});
