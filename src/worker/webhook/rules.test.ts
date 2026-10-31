import { describe, expect, it } from "vitest";
import {
  checkSubscriptionRequest,
  decideActivity,
  decideWebhookAction,
  parseWebhookEvent,
} from "./rules";

const OWNER = 42;
const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

const activityEvent = (aspect: string, ownerId = OWNER) => ({
  object_type: "activity",
  object_id: 1001,
  aspect_type: aspect,
  owner_id: ownerId,
  subscription_id: 7,
  event_time: 1761800000,
  updates: {},
});

describe("parseWebhookEvent", () => {
  it("reads an activity event", () => {
    expect(parseWebhookEvent(activityEvent("create"))).toEqual({
      objectType: "activity",
      aspectType: "create",
      objectId: 1001,
      ownerId: OWNER,
      deauthorized: false,
    });
  });

  it.each([
    ["the string false", "false"],
    ["the boolean false", false],
  ])("detects a deauthorization sent as %s", (_label, authorized) => {
    const event = parseWebhookEvent({
      object_type: "athlete",
      object_id: OWNER,
      aspect_type: "update",
      owner_id: OWNER,
      updates: { authorized },
    });
    expect(event?.deauthorized).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "event"],
    [
      "an unknown object type",
      { ...activityEvent("create"), object_type: "club" },
    ],
    ["an unknown aspect type", activityEvent("rename")],
    ["a string object id", { ...activityEvent("create"), object_id: "1001" }],
    ["a negative owner id", { ...activityEvent("create"), owner_id: -1 }],
    ["a missing owner id", { ...activityEvent("create"), owner_id: undefined }],
    ["a string owner id", { ...activityEvent("create"), owner_id: "42" }],
    ["a decimal object id", { ...activityEvent("create"), object_id: 1.5 }],
    ["a zero object id", { ...activityEvent("create"), object_id: 0 }],
    [
      "an unsafe integer object id",
      { ...activityEvent("create"), object_id: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ])("rejects %s", (_label, body) => {
    expect(parseWebhookEvent(body)).toBeNull();
  });
});

describe("parseWebhookEvent authorized flag", () => {
  const athleteEvent = (updates: unknown) => ({
    object_type: "athlete",
    object_id: OWNER,
    aspect_type: "update",
    owner_id: OWNER,
    updates,
  });

  it.each([
    ["the string true", { authorized: "true" }],
    ["the boolean true", { authorized: true }],
    ["another casing of false", { authorized: "False" }],
    ["zero", { authorized: 0 }],
    ["no authorized field", {}],
    ["no updates object", undefined],
    ["updates sent as a string", "authorized=false"],
  ])("does not flag a deauthorization for %s", (_label, updates) => {
    expect(parseWebhookEvent(athleteEvent(updates))?.deauthorized).toBe(false);
  });
});

describe("decideWebhookAction", () => {
  const decide = (body: unknown, owner: number | null = OWNER) =>
    decideWebhookAction(parseWebhookEvent(body), owner);

  it.each(["create", "update"])("refreshes the activity on %s", (aspect) => {
    expect(decide(activityEvent(aspect))).toEqual({
      kind: "refresh-activity",
      athleteId: OWNER,
      activityId: 1001,
    });
  });

  it("removes the activity on delete", () => {
    expect(decide(activityEvent("delete"))).toEqual({
      kind: "remove-activity",
      athleteId: OWNER,
      activityId: 1001,
    });
  });

  it("deauthorizes on an athlete event with authorized=false", () => {
    expect(
      decide({
        object_type: "athlete",
        object_id: OWNER,
        aspect_type: "update",
        owner_id: OWNER,
        updates: { authorized: "false" },
      }),
    ).toEqual({ kind: "deauthorize", athleteId: OWNER });
  });

  it("ignores other athlete updates", () => {
    expect(
      decide({
        object_type: "athlete",
        object_id: OWNER,
        aspect_type: "update",
        owner_id: OWNER,
        updates: { title: "x" },
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("ignores events from another athlete", () => {
    expect(decide(activityEvent("create", 43))).toEqual({ kind: "ignore" });
  });

  it("ignores everything when no owner is configured", () => {
    expect(decide(activityEvent("create"), null)).toEqual({ kind: "ignore" });
  });

  it("ignores invalid events", () => {
    expect(decide({ hello: "world" })).toEqual({ kind: "ignore" });
  });
});

describe("checkSubscriptionRequest", () => {
  it("returns the challenge when token and mode are correct", () => {
    expect(checkSubscriptionRequest("subscribe", "abc-123_X", true)).toEqual({
      kind: "ok",
      challenge: "abc-123_X",
    });
  });

  it("forbids a wrong token, whatever the other parameters", () => {
    expect(checkSubscriptionRequest("subscribe", "abc", false)).toEqual({
      kind: "forbidden",
    });
  });

  it.each([
    ["a wrong mode", "unsubscribe", "abc"],
    ["a missing mode", undefined, "abc"],
    ["a missing challenge", "subscribe", undefined],
    ["an empty challenge", "subscribe", ""],
    ["a challenge with markup", "subscribe", "<script>"],
    ["a too long challenge", "subscribe", "a".repeat(257)],
  ])("rejects %s", (_label, mode, challenge) => {
    expect(checkSubscriptionRequest(mode, challenge, true)).toEqual({
      kind: "invalid",
    });
  });
});

describe("decideActivity", () => {
  const recentRun = {
    id: 1001,
    athlete: { id: OWNER },
    sport_type: "Run",
    start_date: "2026-10-29T07:00:00Z",
  };

  it("stores a recent run of the owner", () => {
    expect(decideActivity(recentRun, 1001, OWNER, NOW_MS)).toEqual({
      kind: "store",
      activity: recentRun,
    });
  });

  it.each([
    ["another sport", { ...recentRun, sport_type: "Ride" }],
    [
      "a run started more than 7 days ago",
      { ...recentRun, start_date: "2026-10-23T11:59:59Z" },
    ],
    ["a run without start date", { ...recentRun, start_date: undefined }],
    ["a run of another athlete", { ...recentRun, athlete: { id: 43 } }],
    ["a run without athlete", { ...recentRun, athlete: undefined }],
  ])("removes %s", (_label, payload) => {
    expect(decideActivity(payload, 1001, OWNER, NOW_MS)).toEqual({
      kind: "remove",
    });
  });

  it("keeps a run started exactly 7 days ago", () => {
    const payload = { ...recentRun, start_date: "2026-10-23T12:00:00Z" };
    expect(decideActivity(payload, 1001, OWNER, NOW_MS).kind).toBe("store");
  });

  it.each([
    ["null", null],
    ["a mismatching id", { ...recentRun, id: 9 }],
  ])("flags %s as invalid", (_label, payload) => {
    expect(decideActivity(payload, 1001, OWNER, NOW_MS)).toEqual({
      kind: "invalid",
    });
  });
});
