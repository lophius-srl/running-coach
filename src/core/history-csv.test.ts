import { describe, expect, it } from "vitest";
import { ACTIVITIES_SAMPLE_CSV } from "./fixtures/activities-sample";
import {
  IMPORT_BATCH_SIZE,
  invalidReason,
  normalizeLabel,
  parseActivityDate,
  parseCsv,
  parseDecimal,
  readActivitiesCsv,
  toBatches,
  validateImportedRun,
  type HistoryFile,
  type ImportedRun,
} from "./history-csv";

const HEADER =
  "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time";

function readFile(text: string): HistoryFile {
  const result = readActivitiesCsv(text);
  if (!result.ok) throw new Error(`missing ${result.missingColumns}`);
  return result.file;
}

const run: ImportedRun = {
  id: 4884325112,
  startDate: "2021-03-14T07:02:11.000Z",
  sportType: "Run",
  name: "Footing du dimanche",
  distanceM: 10021.3,
  movingTimeS: 3010,
  elevationGainM: 87,
  averageHeartrate: 152.3,
};

describe("parseCsv", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('a,"b, ""c""\nd",e\n1,2,3')).toEqual([
      ["a", 'b, "c"\nd', "e"],
      ["1", "2", "3"],
    ]);
  });

  it("strips the UTF-8 BOM and accepts CRLF line endings", () => {
    expect(parseCsv("﻿a,b\r\n1,\r\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("keeps a quote in the middle of an unquoted field", () => {
    expect(parseCsv('5" tapis,x')).toEqual([['5" tapis', "x"]]);
  });
});

describe("normalizeLabel", () => {
  it("ignores case, accents, spaces and punctuation", () => {
    expect(normalizeLabel(" Type d'Activité ")).toBe("typedactivite");
    expect(normalizeLabel("Trail Run")).toBe(normalizeLabel("TrailRun"));
  });
});

describe("parseDecimal", () => {
  it.each([
    ["10.02", 10.02],
    ["21,10", 21.1],
    [" 3010 ", 3010],
  ])("reads %j", (text, value) => {
    expect(parseDecimal(text)).toBe(value);
  });

  it.each(["", "abc", "-1", "1.2.3", "1 000", undefined])(
    "rejects %j",
    (text) => {
      expect(parseDecimal(text)).toBeNull();
    },
  );
});

describe("parseActivityDate", () => {
  it.each([
    ["Mar 14, 2021, 7:02:11 AM", "2021-03-14T07:02:11.000Z"],
    ["Mar 14, 2021, 12:05:00 AM", "2021-03-14T00:05:00.000Z"],
    ["Mar 14, 2021, 12:05:00 PM", "2021-03-14T12:05:00.000Z"],
    ["Dec 31, 2021, 11:59:59 PM", "2021-12-31T23:59:59.000Z"],
    ["Sept 1, 2022, 6:00:00 pm", "2022-09-01T18:00:00.000Z"],
  ])("reads %j as UTC", (text, iso) => {
    expect(parseActivityDate(text)).toBe(iso);
  });

  it.each([
    "Feb 30, 2022, 7:00:00 AM",
    "Foo 1, 2022, 7:00:00 AM",
    "Mar 14, 2021, 13:00:00 PM",
    "Mar 14, 2021, 7:60:00 AM",
    "2021-03-14T07:02:11Z",
    "",
  ])("rejects %j", (text) => {
    expect(parseActivityDate(text)).toBeNull();
  });
});

describe("readActivitiesCsv on the synthetic Strava export", () => {
  const file = readFile(ACTIVITIES_SAMPLE_CSV);

  it("keeps only the runs, sorted by date", () => {
    expect(file.runs.map((r) => r.id)).toEqual([
      4884325112, 4950000002, 5100000004, 16000000007,
    ]);
    expect(file.firstDate).toBe("2021-03-14T07:02:11.000Z");
    expect(file.lastDate).toBe("2026-10-28T06:45:03.000Z");
  });

  it("counts the other sports and the invalid runs by reason", () => {
    expect(file.otherSports).toBe(2);
    expect(file.invalid).toEqual({
      id: 0,
      date: 1,
      distance: 0,
      duration: 0,
      pace: 1,
    });
  });

  it("extracts only the summary fields, preferring metres and moving time", () => {
    expect(file.runs[0]).toEqual(run);
  });

  it("falls back to the km distance with a decimal comma", () => {
    expect(file.runs[1]).toMatchObject({
      sportType: "TrailRun",
      name: "Trail des crêtes, boucle nord",
      distanceM: 21100,
      movingTimeS: 9000,
      elevationGainM: 850,
      averageHeartrate: null,
    });
  });

  it("falls back to the elapsed time when the moving time is empty", () => {
    expect(file.runs[2]).toMatchObject({
      sportType: "VirtualRun",
      movingTimeS: 1800,
      elevationGainM: null,
      averageHeartrate: 140,
    });
  });

  it("gives the same result with CRLF line endings", () => {
    expect(readFile(ACTIVITIES_SAMPLE_CSV.replaceAll("\n", "\r\n"))).toEqual(
      file,
    );
  });

  it("produces runs that the Worker accepts unchanged", () => {
    for (const parsed of file.runs) {
      expect(validateImportedRun(parsed)).toEqual(parsed);
    }
  });
});

describe("readActivitiesCsv", () => {
  it("finds columns by name, whatever their order, case or accents", () => {
    const text =
      "moving time,DISTANCE,Type d'activité,Date de l'activité,ID de l'activité\n" +
      '1800,"5,0",Course à pied,"Mar 14, 2021, 7:02:11 AM",42\n';

    expect(readFile(text).runs).toEqual([
      {
        id: 42,
        startDate: "2021-03-14T07:02:11.000Z",
        sportType: "Run",
        name: "",
        distanceM: 5000,
        movingTimeS: 1800,
        elevationGainM: null,
        averageHeartrate: null,
      },
    ]);
  });

  it("lists the missing required columns", () => {
    expect(readActivitiesCsv("Activity ID,Activity Name\n1,x\n")).toEqual({
      ok: false,
      missingColumns: [
        "Activity Date",
        "Activity Type",
        "Distance",
        "Moving Time",
      ],
    });
  });

  it.each([
    ["an empty file", ""],
    ["a binary file", "PK\u0003\u0004\u0014\u0000\u0008"],
  ])("refuses %s", (_label, text) => {
    expect(readActivitiesCsv(text).ok).toBe(false);
  });

  it("keeps the last line of a run listed twice", () => {
    const text =
      `${HEADER}\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",avant,Run,10,3000\n' +
      '1,"Mar 14, 2021, 7:02:11 AM",après,Run,10,3000\n';

    expect(readFile(text).runs.map((r) => r.name)).toEqual(["après"]);
  });

  it("rejects rows with an unreadable id, distance or duration, and skips blank lines", () => {
    const text =
      `${HEADER}\n\n` +
      'abc,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000\n' +
      '2,"Mar 14, 2021, 7:02:11 AM",,Run,,3000\n' +
      '3,"Mar 14, 2021, 7:02:11 AM",,Run,10,0\n' +
      '4,"Mar 14, 2021, 7:02:11 AM",,Run,100,3000\n';

    expect(readFile(text)).toEqual({
      runs: [],
      otherSports: 0,
      invalid: { id: 1, date: 0, distance: 1, duration: 1, pace: 1 },
      firstDate: null,
      lastDate: null,
    });
  });

  it("truncates long names to 200 characters", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",${"é".repeat(300)},Run,10,3000\n`;

    expect([...readFile(text).runs[0].name]).toHaveLength(200);
  });
});

describe("invalidReason", () => {
  it("accepts paces between 2 and 20 min/km", () => {
    expect(invalidReason({ ...run, distanceM: 1000, movingTimeS: 120 })).toBe(
      null,
    );
    expect(invalidReason({ ...run, distanceM: 1000, movingTimeS: 1200 })).toBe(
      null,
    );
    expect(invalidReason({ ...run, distanceM: 1000, movingTimeS: 119 })).toBe(
      "pace",
    );
    expect(invalidReason({ ...run, distanceM: 1000, movingTimeS: 1201 })).toBe(
      "pace",
    );
  });
});

describe("validateImportedRun", () => {
  it("accepts a valid run without the optional fields", () => {
    const minimal = {
      id: run.id,
      startDate: run.startDate,
      sportType: "TrailRun",
      distanceM: 10000,
      movingTimeS: 3000,
    };

    expect(validateImportedRun(minimal)).toEqual({
      ...minimal,
      name: "",
      elevationGainM: null,
      averageHeartrate: null,
    });
  });

  it("truncates the name", () => {
    expect(validateImportedRun({ ...run, name: "x".repeat(250) })?.name).toBe(
      "x".repeat(200),
    );
  });

  it.each([
    ["not an object", null],
    ["a string id", { ...run, id: "1" }],
    ["a decimal id", { ...run, id: 1.5 }],
    ["a non-ISO date", { ...run, startDate: "2021-03-14" }],
    ["another sport", { ...run, sportType: "Ride" }],
    ["a non-string name", { ...run, name: 42 }],
    ["a string distance", { ...run, distanceM: "10000" }],
    ["a decimal duration", { ...run, movingTimeS: 3010.5 }],
    ["an implausible pace", { ...run, movingTimeS: 60 }],
    ["a negative elevation", { ...run, elevationGainM: -1 }],
    ["a string heart rate", { ...run, averageHeartrate: "150" }],
    ["a zero heart rate", { ...run, averageHeartrate: 0 }],
  ])("refuses %s", (_label, value) => {
    expect(validateImportedRun(value)).toBeNull();
  });
});

describe("toBatches", () => {
  it("splits into batches of at most 200 items", () => {
    const items = Array.from(
      { length: 2 * IMPORT_BATCH_SIZE + 1 },
      (_, i) => i,
    );

    expect(toBatches(items).map((batch) => batch.length)).toEqual([
      200, 200, 1,
    ]);
    expect(toBatches(items).flat()).toEqual(items);
  });

  it("returns no batch for no item", () => {
    expect(toBatches([])).toEqual([]);
  });
});
