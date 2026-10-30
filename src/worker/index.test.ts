import { describe, expect, it } from "vitest";
import { app } from "./index";

describe("GET /health", () => {
  it("returns status ok", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("session guard exemptions", () => {
  it.each([
    "/api/strava/webhooks",
    "/api/strava/webhook-admin",
    "/api/strava/webhook/admin",
  ])(
    "does not exempt %s, which only starts like the webhook path",
    async (path) => {
      const response = await app.request(path, {}, {});

      expect(response.status).toBe(401);
    },
  );

  it("exempts the exact webhook path", async () => {
    const response = await app.request("/api/strava/webhook", {}, {});

    expect(response.status).not.toBe(401);
  });
});
