import { describe, expect, it } from "vitest";
import { ACTIVITIES_SAMPLE_CSV } from "../core/fixtures/activities-sample";
import {
  IMPORT_BATCH_SIZE,
  readActivitiesCsv,
  type HistoryFile,
  type ImportedRun,
} from "../core/history-csv";
import {
  fileProblem,
  ImportRequestError,
  MAX_FILE_BYTES,
  payloadBatches,
  previewOf,
  readErrorMessage,
  sendBatches,
  sendErrorMessage,
  startProgress,
  toPayload,
  type Progress,
  type SendBatch,
} from "./history-import";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

function readSample(): HistoryFile {
  const result = readActivitiesCsv(ACTIVITIES_SAMPLE_CSV, NOW_MS);
  if (!result.ok) throw new Error(result.reason);
  return result.file;
}

function makeRuns(count: number): ImportedRun[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    startDate: "2021-03-14T07:02:11.000Z",
    sportType: "Run",
    name: `Course ${i + 1}`,
    distanceM: 10000,
    movingTimeS: 3000,
    elevationGainM: null,
    averageHeartrate: null,
  }));
}

// Faux serveur : dédoublonne par id comme imported_activities, et peut échouer à un appel donné.
function fakeServer(failOnCall?: number) {
  const stored = new Set<number>();
  let calls = 0;
  const send: SendBatch = async (rows) => {
    calls++;
    if (calls === failOnCall) throw new Error("network");
    const alreadyPresent = rows.filter((row) => stored.has(row.id)).length;
    rows.forEach((row) => stored.add(row.id));
    return { inserted: rows.length - alreadyPresent, alreadyPresent };
  };
  return { send, stored };
}

describe("fileProblem", () => {
  it("refuses the .zip archive and asks to extract activities.csv", () => {
    expect(fileProblem({ name: "export_123.ZIP", size: 1000 })).toContain(
      "activities.csv",
    );
  });

  it("refuses a file too large to be activities.csv", () => {
    const name = "activities.csv";
    expect(fileProblem({ name, size: MAX_FILE_BYTES + 1 })).not.toBeNull();
    expect(fileProblem({ name, size: MAX_FILE_BYTES })).toBeNull();
  });
});

describe("readErrorMessage", () => {
  it("names the missing columns and suggests an English export", () => {
    const result = readActivitiesCsv("foo,bar\n1,2", NOW_MS);
    if (result.ok) throw new Error("should be refused");
    const message = readErrorMessage(result);
    expect(message).toContain("Activity ID");
    expect(message).toContain("anglais");
  });

  it("explains a malformed file and unreadable dates", () => {
    expect(readErrorMessage({ reason: "malformed" })).toContain("CSV");
    expect(readErrorMessage({ reason: "dateFormat" })).toContain("dates");
  });

  it("refuses a binary file that is not a CSV", () => {
    const result = readActivitiesCsv(
      "PK\u0003\u0004\u0000\u0014binary",
      NOW_MS,
    );
    expect(result.ok).toBe(false);
  });
});

describe("previewOf", () => {
  it("counts runs, period and ignored rows of the sample export", () => {
    expect(previewOf(readSample())).toEqual({
      runs: 4,
      firstDate: "2021-03-14T07:02:11.000Z",
      lastDate: "2026-10-28T06:45:03.000Z",
      ignored: 4,
      otherSports: 2,
      invalid: 2,
      duplicates: 0,
    });
  });

  it("counts a run repeated in the file as ignored", () => {
    const header =
      "Activity ID,Activity Date,Activity Type,Distance,Moving Time";
    const line = '1,"Mar 14, 2021, 7:02:11 AM",Run,10.0,3000';
    const result = readActivitiesCsv(`${header}\n${line}\n${line}`, NOW_MS);
    if (!result.ok) throw new Error(result.reason);
    expect(previewOf(result.file)).toMatchObject({
      runs: 1,
      duplicates: 1,
      ignored: 1,
    });
  });
});

describe("toPayload", () => {
  it("sends only the summarised fields of a run", () => {
    const run = { ...makeRuns(1)[0], description: "privé", gear: "Pegasus" };
    expect(Object.keys(toPayload(run)).sort()).toEqual([
      "averageHeartrate",
      "distanceM",
      "elevationGainM",
      "id",
      "movingTimeS",
      "name",
      "sportType",
      "startDate",
    ]);
  });

  it("never sends the description or the gear of the sample export", () => {
    const json = JSON.stringify(payloadBatches(readSample().runs));
    expect(json).not.toContain("jambes");
    expect(json).not.toContain("Pegasus");
    expect(json).not.toContain("Échauffement");
  });
});

describe("payloadBatches", () => {
  it("splits thousands of runs into batches the Worker accepts", () => {
    const batches = payloadBatches(makeRuns(3001));
    expect(batches).toHaveLength(16);
    expect(batches.every((b) => b.length <= IMPORT_BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toHaveLength(3001);
  });
});

describe("sendBatches", () => {
  it("sends every batch in order and sums the report", async () => {
    const batches = payloadBatches(makeRuns(450));
    const { send } = fakeServer();
    const seen: Progress[] = [];
    const outcome = await sendBatches(
      batches,
      startProgress(batches.length),
      send,
      (progress) => seen.push(progress),
    );
    expect(outcome).toEqual({
      ok: true,
      progress: {
        nextBatch: 3,
        totalBatches: 3,
        inserted: 450,
        alreadyPresent: 0,
      },
    });
    expect(seen.map((p) => p.nextBatch)).toEqual([1, 2, 3]);
  });

  it("reports 0 imported and N already present on a re-import", async () => {
    const batches = payloadBatches(makeRuns(450));
    const { send } = fakeServer();
    await sendBatches(batches, startProgress(3), send, () => {});
    const again = await sendBatches(batches, startProgress(3), send, () => {});
    expect(again.progress).toMatchObject({ inserted: 0, alreadyPresent: 450 });
  });

  it("stops on a failed batch and resumes it without duplicates", async () => {
    const batches = payloadBatches(makeRuns(450));
    const server = fakeServer(2);
    const failed = await sendBatches(
      batches,
      startProgress(3),
      server.send,
      () => {},
    );
    expect(failed.ok).toBe(false);
    expect(failed.progress).toMatchObject({ nextBatch: 1, inserted: 200 });

    const resumed = await sendBatches(
      batches,
      failed.progress,
      server.send,
      () => {},
    );
    expect(resumed).toEqual({
      ok: true,
      progress: {
        nextBatch: 3,
        totalBatches: 3,
        inserted: 450,
        alreadyPresent: 0,
      },
    });
    expect(server.stored.size).toBe(450);
  });

  it("does nothing when there is no run to send", async () => {
    let called = false;
    const outcome = await sendBatches(
      [],
      startProgress(0),
      async () => {
        called = true;
        return { inserted: 0, alreadyPresent: 0 };
      },
      () => {},
    );
    expect(outcome.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe("sendErrorMessage", () => {
  it("asks to log in again when the session has expired", () => {
    expect(sendErrorMessage(new ImportRequestError(401))).toContain(
      "reconnecte",
    );
  });

  it("offers to resume after a network or server error", () => {
    expect(sendErrorMessage(new TypeError("fetch failed"))).toContain(
      "Relance",
    );
    expect(sendErrorMessage(new ImportRequestError(500))).toContain("Relance");
  });
});
