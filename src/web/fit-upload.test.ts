import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitUpload } from "./FitUpload";
import { fitFileProblem, fitUploadOutcome, uploadFit } from "./fit-upload";

const MIB_1_5 = 1.5 * 1024 * 1024;
const TOO_LARGE = "Fichier trop gros : 1,5 Mo au maximum pour une séance.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fitUploadOutcome", () => {
  it.each([
    ["imported", true],
    ["duplicate", true],
    ["not_fit", false],
    ["invalid", false],
    ["quota", false],
    ["unauthorized", false],
    ["too_large", false],
  ])("reports %s with the server message", (status, ok) => {
    expect(fitUploadOutcome({ status, message: "Message." })).toEqual({
      ok,
      message: "Message.",
    });
  });

  it.each([null, {}, { status: "imported" }, "texte"])(
    "falls back to a generic error for %j",
    (body) => {
      expect(fitUploadOutcome(body)).toEqual({
        ok: false,
        message: "Envoi impossible. Vérifie ta connexion, puis réessaie.",
      });
    },
  );
});

describe("fitFileProblem", () => {
  it("accepts a file of exactly 1.5 MiB", () => {
    expect(fitFileProblem({ size: MIB_1_5 })).toBeNull();
  });

  it("refuses a larger file with the server's 413 message", () => {
    expect(fitFileProblem({ size: MIB_1_5 + 1 })).toBe(TOO_LARGE);
  });
});

describe("uploadFit", () => {
  it("does not send a file over 1.5 MiB", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const file = new File([new Uint8Array(MIB_1_5 + 1)], "seance.fit");

    expect(await uploadFit(file)).toEqual({ ok: false, message: TOO_LARGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the file as multipart field `file` to /api/imports/fit", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ status: "imported", message: "Séance importée" }),
      );
    const file = new File([new Uint8Array([1, 2, 3])], "seance.fit");

    expect(await uploadFit(file)).toEqual({
      ok: true,
      message: "Séance importée",
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/imports/fit");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("reports a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const outcome = await uploadFit(new File([], "seance.fit"));
    expect(outcome.ok).toBe(false);
  });
});

describe("FitUpload", () => {
  it("offers the button and a .fit file picker", () => {
    const html = renderToStaticMarkup(createElement(FitUpload));
    expect(html).toContain("Importer un fichier FIT");
    expect(html).toContain('accept=".fit"');
  });
});
