import { describe, expect, it } from "vitest";
import { syncStateFrom } from "./useSync";

describe("syncStateFrom", () => {
  it("reports the number of synced runs", () => {
    expect(syncStateFrom(200, { imported: 3 })).toEqual({
      status: "done",
      imported: 3,
    });
  });

  it("asks to reconnect when Strava access was revoked", () => {
    expect(
      syncStateFrom(401, { error: "strava_reauthorization_required" }),
    ).toEqual({ status: "revoked" });
  });

  it.each([
    ["an expired session", 401, { error: "unauthorized" }],
    ["a Strava failure", 502, { error: "strava" }],
    ["an unexpected body", 200, null],
    ["a non-numeric count", 200, { imported: "3" }],
  ])("reports a failure for %s", (_label, status, body) => {
    expect(syncStateFrom(status, body)).toEqual({ status: "failed" });
  });
});
