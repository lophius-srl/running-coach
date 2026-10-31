import { afterEach, describe, expect, it, vi } from "vitest";
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
  isRetryable,
  MAX_FILE_BYTES,
  payloadBatches,
  postBatch,
  previewOf,
  readErrorMessage,
  REQUEST_TIMEOUT_MS,
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

const HEADER = "Activity ID,Activity Date,Activity Type,Distance,Moving Time";

function readCsv(text: string): HistoryFile {
  const result = readActivitiesCsv(text, NOW_MS);
  if (!result.ok) throw new Error(result.reason);
  return result.file;
}

// Faux serveur : dédoublonne par id comme imported_activities, et peut échouer à des appels donnés.
function fakeServer(...failOnCalls: number[]) {
  const stored = new Set<number>();
  let calls = 0;
  const send: SendBatch = async (rows) => {
    calls++;
    if (failOnCalls.includes(calls)) throw new Error("network");
    const alreadyPresent = rows.filter((row) => stored.has(row.id)).length;
    rows.forEach((row) => stored.add(row.id));
    return { inserted: rows.length - alreadyPresent, alreadyPresent };
  };
  return { send, stored, calls: () => calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("isRetryable", () => {
  it("retries a network failure", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("retries a timeout", () => {
    expect(
      isRetryable(new DOMException("signal timed out", "TimeoutError")),
    ).toBe(true);
  });

  it("retries a server error", () => {
    expect(isRetryable(new ImportRequestError(500))).toBe(true);
    expect(isRetryable(new ImportRequestError(503))).toBe(true);
  });

  it("retries when rate limited", () => {
    expect(isRetryable(new ImportRequestError(429))).toBe(true);
  });

  it("does not retry a rejected batch", () => {
    expect(isRetryable(new ImportRequestError(400))).toBe(false);
  });

  it("does not retry an expired session", () => {
    expect(isRetryable(new ImportRequestError(401))).toBe(false);
  });

  it("does not retry a batch too large", () => {
    expect(isRetryable(new ImportRequestError(413))).toBe(false);
  });

  it("does not retry other client errors", () => {
    expect(isRetryable(new ImportRequestError(404))).toBe(false);
  });
});

describe("sendErrorMessage", () => {
  it("asks to log in again and drop the file again when the session has expired", () => {
    const message = sendErrorMessage(new ImportRequestError(401));
    expect(message).toContain("reconnecte-toi");
    expect(message).toContain("dépose à nouveau activities.csv");
    expect(message).toContain("déjà présentes");
    expect(message).not.toContain("relance");
  });

  it("asks to reload the page when the batch was refused", () => {
    for (const status of [400, 413]) {
      expect(sendErrorMessage(new ImportRequestError(status))).toContain(
        "refusé par le serveur",
      );
    }
  });

  it("offers to resume after a network or server error", () => {
    expect(sendErrorMessage(new TypeError("fetch failed"))).toContain(
      "Relance",
    );
    expect(sendErrorMessage(new ImportRequestError(500))).toContain("Relance");
    expect(sendErrorMessage(new ImportRequestError(429))).toContain("Relance");
  });
});

describe("edge cases of the file", () => {
  it("lets an empty file reach the CSV check instead of refusing it early", () => {
    expect(fileProblem({ name: "activities.csv", size: 0 })).toBeNull();
  });

  it("explains an empty file by listing every required column", () => {
    const result = readActivitiesCsv("", NOW_MS);
    if (result.ok) throw new Error("should be refused");
    const message = readErrorMessage(result);
    for (const column of [
      "Activity ID",
      "Activity Date",
      "Activity Type",
      "Distance",
      "Moving Time",
    ]) {
      expect(message).toContain(column);
    }
  });

  it("shows no run and no period for a file with headers only", () => {
    expect(previewOf(readCsv(`${HEADER}\n`))).toEqual({
      runs: 0,
      firstDate: null,
      lastDate: null,
      ignored: 0,
      otherSports: 0,
      invalid: 0,
      duplicates: 0,
    });
    expect(payloadBatches(readCsv(HEADER).runs)).toEqual([]);
  });

  it("counts a file without any run as other sports only", () => {
    const ride = '1,"Mar 14, 2021, 7:02:11 AM",Ride,40.0,5000';
    const swim = '2,"Mar 15, 2021, 7:02:11 AM",Swim,2.0,3000';
    expect(previewOf(readCsv(`${HEADER}\n${ride}\n${swim}`))).toMatchObject({
      runs: 0,
      firstDate: null,
      ignored: 2,
      otherSports: 2,
    });
  });

  it("gives the same first and last date for a single run", () => {
    const line = '1,"Mar 14, 2021, 7:02:11 AM",Run,10.0,3000';
    expect(previewOf(readCsv(`${HEADER}\n${line}`))).toMatchObject({
      runs: 1,
      firstDate: "2021-03-14T07:02:11.000Z",
      lastDate: "2021-03-14T07:02:11.000Z",
    });
  });
});

describe("batch boundaries", () => {
  it("sends exactly 200 runs in a single batch", () => {
    expect(payloadBatches(makeRuns(200)).map((b) => b.length)).toEqual([200]);
  });

  it("sends 201 runs in a full batch and a batch of one", () => {
    expect(payloadBatches(makeRuns(201)).map((b) => b.length)).toEqual([
      200, 1,
    ]);
  });
});

describe("sendBatches edge cases", () => {
  it("makes a single call for exactly 200 runs", async () => {
    const batches = payloadBatches(makeRuns(200));
    const server = fakeServer();
    const outcome = await sendBatches(
      batches,
      startProgress(batches.length),
      server.send,
      () => {},
    );
    expect(server.calls()).toBe(1);
    expect(outcome.progress).toMatchObject({ nextBatch: 1, inserted: 200 });
  });

  it("keeps the 401 error and the progress reached in the middle of the import", async () => {
    const batches = payloadBatches(makeRuns(450));
    let calls = 0;
    const send: SendBatch = async (rows) => {
      calls++;
      if (calls === 2) throw new ImportRequestError(401);
      return { inserted: rows.length, alreadyPresent: 0 };
    };
    const outcome = await sendBatches(
      batches,
      startProgress(3),
      send,
      () => {},
    );
    if (outcome.ok) throw new Error("should fail");
    expect(sendErrorMessage(outcome.error)).toContain("reconnecte");
    expect(outcome.progress).toMatchObject({ nextBatch: 1, inserted: 200 });
  });

  it("does not report progress for the failed last batch, then finishes it on resume", async () => {
    const batches = payloadBatches(makeRuns(450));
    const server = fakeServer(3);
    const seen: number[] = [];
    const failed = await sendBatches(
      batches,
      startProgress(3),
      server.send,
      (p) => seen.push(p.nextBatch),
    );
    expect(failed.ok).toBe(false);
    expect(seen).toEqual([1, 2]);
    expect(failed.progress).toMatchObject({ nextBatch: 2, inserted: 400 });

    const resumed = await sendBatches(
      batches,
      failed.progress,
      server.send,
      () => {},
    );
    expect(resumed.progress).toMatchObject({
      nextBatch: 3,
      inserted: 450,
      alreadyPresent: 0,
    });
    expect(server.stored.size).toBe(450);
  });

  it("finishes after several interruptions with exact totals and no duplicates", async () => {
    const batches = payloadBatches(makeRuns(1000));
    const server = fakeServer(2, 3, 5);
    let outcome = await sendBatches(
      batches,
      startProgress(batches.length),
      server.send,
      () => {},
    );
    let attempts = 1;
    while (!outcome.ok) {
      outcome = await sendBatches(
        batches,
        outcome.progress,
        server.send,
        () => {},
      );
      attempts++;
    }
    expect(attempts).toBe(4);
    expect(outcome.progress).toMatchObject({
      nextBatch: 5,
      inserted: 1000,
      alreadyPresent: 0,
    });
    expect(server.stored.size).toBe(1000);
  });

  it("counts as already present a batch stored by the server whose answer was lost", async () => {
    const batches = payloadBatches(makeRuns(450));
    const server = fakeServer();
    let lostAnswer = true;
    const send: SendBatch = async (rows) => {
      const result = await server.send(rows);
      if (server.calls() === 2 && lostAnswer) {
        lostAnswer = false;
        throw new TypeError("connection reset");
      }
      return result;
    };
    const failed = await sendBatches(batches, startProgress(3), send, () => {});
    const resumed = await sendBatches(batches, failed.progress, send, () => {});
    expect(resumed.progress).toMatchObject({
      inserted: 250,
      alreadyPresent: 200,
    });
    expect(server.stored.size).toBe(450);
  });

  it("restarting from the first batch after a reload creates no duplicate", async () => {
    const batches = payloadBatches(makeRuns(450));
    const server = fakeServer(2);
    await sendBatches(batches, startProgress(3), server.send, () => {});
    const restarted = await sendBatches(
      batches,
      startProgress(3),
      server.send,
      () => {},
    );
    expect(restarted.progress).toMatchObject({
      inserted: 250,
      alreadyPresent: 200,
    });
    expect(server.stored.size).toBe(450);
  });

  it("sends nothing when resuming an import already finished", async () => {
    const batches = payloadBatches(makeRuns(450));
    const server = fakeServer();
    const done = await sendBatches(
      batches,
      startProgress(3),
      server.send,
      () => {},
    );
    const again = await sendBatches(
      batches,
      done.progress,
      server.send,
      () => {},
    );
    expect(server.calls()).toBe(3);
    expect(again).toEqual(done);
  });
});

describe("postBatch", () => {
  function stubFetch(response: Response) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  }

  it("posts the rows as JSON to the import endpoint", async () => {
    const fetchSpy = stubFetch(
      Response.json({ inserted: 1, alreadyPresent: 0 }),
    );
    const rows = makeRuns(1);
    expect(await postBatch(rows)).toEqual({ inserted: 1, alreadyPresent: 0 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/history/import");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ rows });
  });

  it("throws the HTTP status when the session has expired", async () => {
    stubFetch(Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(postBatch(makeRuns(1))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("lets a network failure through so that the import can be resumed", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    await expect(postBatch(makeRuns(1))).rejects.toBeInstanceOf(TypeError);
  });

  it("aborts a request that takes too long, on the resumable path", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const settled = postBatch(makeRuns(1)).catch((e: unknown) => e);
    controller.abort(new DOMException("signal timed out", "TimeoutError"));
    const error = await settled;
    expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(error).toBeInstanceOf(DOMException);
    expect(isRetryable(error)).toBe(true);
  });

  it("rejects a response without integer counts, on the resumable path", async () => {
    stubFetch(Response.json({ inserted: "1", alreadyPresent: 0.5 }));
    const error = await postBatch(makeRuns(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isRetryable(error)).toBe(true);
  });
});
