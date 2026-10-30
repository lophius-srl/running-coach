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

// Horloge figée : les dates de la fixture (≤ 28 oct. 2026) sont dans le passé.
const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

const HEADER =
  "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time";

function readFile(text: string): HistoryFile {
  const result = readActivitiesCsv(text, NOW_MS);
  if (!result.ok) throw new Error(`unreadable: ${result.reason}`);
  return result.file;
}

function ignoredTotal(file: HistoryFile): number {
  return Object.values(file.invalid).reduce((a, b) => a + b, file.otherSports);
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

  it("keeps CRLF line breaks inside a quoted field", () => {
    expect(parseCsv('a,"l1\r\nl2, ""x""",b\r\n1,2,3')).toEqual([
      ["a", 'l1\r\nl2, "x"', "b"],
      ["1", "2", "3"],
    ]);
  });

  it("reads an empty quoted field at the end of the file", () => {
    expect(parseCsv('a,""')).toEqual([["a", ""]]);
  });

  it("reads a file without BOM like a file with one", () => {
    expect(parseCsv("a,b\n1,2")).toEqual(parseCsv("﻿a,b\n1,2"));
  });

  it("terminates on an unclosed quote, keeping the rest of the file in one field", () => {
    expect(parseCsv('a,"b\nc,d\n')).toEqual([["a", "b\nc,d\n"]]);
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

  it.each(["", "abc", "-1", "1.2.3", "1 000", "1,234.5", "1.234,5", undefined])(
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
    ["Mar 1, 2021, 12:00:00 AM", "2021-03-01T00:00:00.000Z"],
    ["Mar 1, 2021, 12:00:00 PM", "2021-03-01T12:00:00.000Z"],
    ["Feb 29, 2024, 7:00:00 AM", "2024-02-29T07:00:00.000Z"],
    ["Mar 14, 2021, 7:02:11 PM", "2021-03-14T19:02:11.000Z"],
  ])("reads %j as UTC", (text, iso) => {
    expect(parseActivityDate(text)).toBe(iso);
  });

  it.each([
    "Feb 30, 2022, 7:00:00 AM",
    "Foo 1, 2022, 7:00:00 AM",
    "Mar 14, 2021, 13:00:00 PM",
    "Mar 14, 2021, 7:60:00 AM",
    "2021-03-14T07:02:11Z",
    "Feb 29, 2023, 7:00:00 AM",
    "Mar 14, 2021, 0:30:00 AM",
    "Mar 14, 2021, 7:02 AM",
    "Mar 14, 2021, 7:02:11",
    "14 mars 2021, 07:02:11",
    "Mar 14, 2021, 7:02:11 AM UTC",
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
      expect(validateImportedRun(parsed, NOW_MS)).toEqual(parsed);
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
    expect(
      readActivitiesCsv("Activity ID,Activity Name\n1,x\n", NOW_MS),
    ).toEqual({
      ok: false,
      reason: "missingColumns",
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
    expect(readActivitiesCsv(text, NOW_MS).ok).toBe(false);
  });

  it("keeps the last line of a run listed twice", () => {
    const text =
      `${HEADER}\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",avant,Run,10,3000\n' +
      '1,"Mar 14, 2021, 7:02:11 AM",après,Run,10,3000\n';

    const file = readFile(text);
    expect(file.runs.map((r) => r.name)).toEqual(["après"]);
    expect(file.duplicates).toBe(1);
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
      duplicates: 0,
      invalid: { id: 1, date: 0, distance: 1, duration: 1, pace: 1 },
      firstDate: null,
      lastDate: null,
    });
  });

  it("refuses a file separated by semicolons, listing the missing columns", () => {
    const text =
      "Activity ID;Activity Date;Activity Type;Distance;Moving Time\n" +
      "1;Mar 14, 2021, 7:02:11 AM;Run;10;3000\n";

    expect(readActivitiesCsv(text, NOW_MS)).toMatchObject({
      ok: false,
      missingColumns: expect.arrayContaining(["Activity ID", "Distance"]),
    });
  });

  it("reads the last line without a trailing line break", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",x,Run,10,3000`;

    expect(readFile(text).runs.map((r) => r.id)).toEqual([1]);
  });

  it("rejects a row shorter than the header instead of crashing", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",x,Run\n`;

    expect(readFile(text).invalid.distance).toBe(1);
  });

  it("ignores the extra cells of a row longer than the header", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",x,Run,10,3000,extra,9\n`;

    expect(readFile(text).runs).toMatchObject([
      { id: 1, distanceM: 10000, movingTimeS: 3000 },
    ]);
  });

  it("does not count blank or whitespace-only lines", () => {
    const text = `${HEADER}\n\n   \n\r\n1,"Mar 14, 2021, 7:02:11 AM",x,Run,10,3000\n\n`;

    const file = readFile(text);
    expect(file.runs).toHaveLength(1);
    expect(ignoredTotal(file)).toBe(0);
  });

  it("rejects a zero or negative distance", () => {
    const text =
      `${HEADER}\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",,Run,0,3000\n' +
      '2,"Mar 14, 2021, 7:02:11 AM",,Run,-10,3000\n';

    expect(readFile(text).invalid.distance).toBe(2);
  });

  it("rejects a distance with an English thousands separator rather than misreading it", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",,Run,"1,234.5",3000\n`;

    expect(readFile(text).invalid.distance).toBe(1);
  });

  it("uses the elapsed time when the moving time is zero, and rejects a run with both at zero", () => {
    const text =
      `${HEADER},Elapsed Time\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",,Run,10,0,3100\n' +
      '2,"Mar 14, 2021, 7:02:11 AM",,Run,10,0,0\n';

    const file = readFile(text);
    expect(file.runs).toMatchObject([{ id: 1, movingTimeS: 3100 }]);
    expect(file.invalid.duration).toBe(1);
  });

  it("rejects an id beyond the safe integer range", () => {
    const text = `${HEADER}\n9007199254740993,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000\n`;

    expect(readFile(text).invalid.id).toBe(1);
  });

  it.each([
    ["0", 0],
    ["20000", 20000],
    ["20000.5", null],
    ["-5", null],
  ])("reads an elevation gain of %j as %j", (cell, value) => {
    const text = `${HEADER},Elevation Gain\n1,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000,${cell}\n`;

    expect(readFile(text).runs[0].elevationGainM).toBe(value);
  });

  it.each([
    ["250", 250],
    ["250.5", null],
    ["0", null],
  ])("reads an average heart rate of %j as %j", (cell, value) => {
    const text = `${HEADER},Average Heart Rate\n1,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000,${cell}\n`;

    expect(readFile(text).runs[0].averageHeartrate).toBe(value);
  });

  it.each(["Trail Run", "TRAIL RUN", "Virtual Run", "Course à pied", "run"])(
    "keeps an activity of type %j",
    (type) => {
      const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",,${type},10,3000\n`;

      expect(readFile(text).runs).toHaveLength(1);
    },
  );

  it.each(["Walk", "Hike", "Ride", ""])(
    "counts an activity of type %j as another sport",
    (type) => {
      const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",,${type},10,3000\n`;

      expect(readFile(text).otherSports).toBe(1);
    },
  );

  it("reports a closing quote followed by other characters", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM","x"y,Run,10,3000\n`;

    expect(readActivitiesCsv(text, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  // Bug trouvé en QA : un guillemet non fermé avalait en silence tout le reste du fichier.
  it("reports an unclosed quote instead of silently dropping the next runs", () => {
    const text =
      `${HEADER},Activity Description\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",x,Run,10,3000,"oops\n' +
      '2,"Mar 15, 2021, 7:02:11 AM",y,Run,10,3000,\n' +
      '3,"Mar 16, 2021, 7:02:11 AM",z,Run,10,3000,\n';

    expect(readActivitiesCsv(text, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  // Bug trouvé en QA : « 1,234 » (milliers à l'anglaise) était lu comme 1,234 m de dénivelé.
  it("does not misread an English thousands separator in the elevation gain", () => {
    const text = `${HEADER},Elevation Gain\n1,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000,"1,234"\n`;

    expect(readFile(text).runs[0].elevationGainM).toBeNull();
  });

  it("skips blank lines before the header", () => {
    const text = `\n\r\n  \n${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",x,Run,10,3000\n`;

    expect(readFile(text).runs.map((r) => r.id)).toEqual([1]);
  });

  it("reads a decimal elevation gain with a comma", () => {
    const text = `${HEADER},Elevation Gain\n1,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000,"12,5"\n`;

    expect(readFile(text).runs[0].elevationGainM).toBe(12.5);
  });

  it("rejects runs dated after tomorrow", () => {
    const text =
      `${HEADER}\n` +
      '1,"Oct 31, 2026, 11:00:00 AM",,Run,10,3000\n' +
      '2,"Nov 1, 2026, 7:00:00 AM",,Run,10,3000\n' +
      '3,"Mar 14, 2021, 7:02:11 AM",,Run,10,3000\n' +
      '4,"Mar 15, 2021, 7:02:11 AM",,Run,10,3000\n';

    const file = readFile(text);
    expect(file.runs.map((r) => r.id)).toEqual([3, 4, 1]);
    expect(file.invalid.date).toBe(1);
  });

  it("rejects a distance above 500 km", () => {
    const text =
      `${HEADER}\n` +
      '1,"Mar 14, 2021, 7:02:11 AM",,Run,500,300000\n' +
      '2,"Mar 14, 2021, 7:02:11 AM",,Run,500.1,300000\n';

    const file = readFile(text);
    expect(file.runs.map((r) => r.id)).toEqual([1]);
    expect(file.invalid.distance).toBe(1);
  });

  it("refuses the file when most run dates are unreadable (localised export)", () => {
    const text =
      `${HEADER}\n` +
      '1,"14 mars 2021, 07:02:11",,Run,10,3000\n' +
      '2,"15 mars 2021, 07:02:11",,Run,10,3000\n' +
      '3,"Mar 16, 2021, 7:02:11 AM",,Run,10,3000\n' +
      '4,"x",,Ride,10,3000\n';

    expect(readActivitiesCsv(text, NOW_MS)).toEqual({
      ok: false,
      reason: "dateFormat",
    });
  });

  it("keeps the file when only some run dates are unreadable", () => {
    const text =
      `${HEADER}\n` +
      '1,"14 mars 2021, 07:02:11",,Run,10,3000\n' +
      '2,"Mar 15, 2021, 7:02:11 AM",,Run,10,3000\n';

    expect(readFile(text).invalid.date).toBe(1);
  });

  it("truncates long names to 200 characters", () => {
    const text = `${HEADER}\n1,"Mar 14, 2021, 7:02:11 AM",${"é".repeat(300)},Run,10,3000\n`;

    expect([...readFile(text).runs[0].name]).toHaveLength(200);
  });
});

describe("invalidReason", () => {
  it("accepts paces between 2 and 20 min/km", () => {
    expect(
      invalidReason({ ...run, distanceM: 1000, movingTimeS: 120 }, NOW_MS),
    ).toBe(null);
    expect(
      invalidReason({ ...run, distanceM: 1000, movingTimeS: 1200 }, NOW_MS),
    ).toBe(null);
    expect(
      invalidReason({ ...run, distanceM: 1000, movingTimeS: 119 }, NOW_MS),
    ).toBe("pace");
    expect(
      invalidReason({ ...run, distanceM: 1000, movingTimeS: 1201 }, NOW_MS),
    ).toBe("pace");
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

    expect(validateImportedRun(minimal, NOW_MS)).toEqual({
      ...minimal,
      name: "",
      elevationGainM: null,
      averageHeartrate: null,
    });
  });

  it("truncates the name", () => {
    expect(
      validateImportedRun({ ...run, name: "x".repeat(250) }, NOW_MS)?.name,
    ).toBe("x".repeat(200));
  });

  it("truncates the name by characters, without splitting an emoji", () => {
    const name = validateImportedRun(
      { ...run, name: "🏃".repeat(250) },
      NOW_MS,
    )?.name;

    expect(name).toBe("🏃".repeat(200));
  });

  it.each([
    [0, 250],
    [20000, 1],
  ])(
    "accepts an elevation of %j m and a heart rate of %j bpm",
    (elevationGainM, averageHeartrate) => {
      expect(
        validateImportedRun(
          { ...run, elevationGainM, averageHeartrate },
          NOW_MS,
        ),
      ).not.toBeNull();
    },
  );

  it("reads a null name as empty", () => {
    expect(validateImportedRun({ ...run, name: null }, NOW_MS)?.name).toBe("");
  });

  it("drops the fields it does not know", () => {
    expect(
      validateImportedRun({ ...run, description: "secret" }, NOW_MS),
    ).toEqual(run);
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
    ["a zero id", { ...run, id: 0 }],
    ["a negative id", { ...run, id: -7 }],
    ["an unsafe id", { ...run, id: 2 ** 53 }],
    [
      "a date without milliseconds",
      { ...run, startDate: "2021-03-14T07:02:11Z" },
    ],
    [
      "a date with an offset",
      { ...run, startDate: "2021-03-14T07:02:11.000+01:00" },
    ],
    [
      "an impossible ISO date",
      { ...run, startDate: "2021-02-30T07:00:00.000Z" },
    ],
    ["a display label as sport type", { ...run, sportType: "Trail Run" }],
    ["a lowercase sport type", { ...run, sportType: "run" }],
    ["a missing sport type", { ...run, sportType: undefined }],
    ["a zero distance", { ...run, distanceM: 0 }],
    ["a negative duration", { ...run, movingTimeS: -3010 }],
    ["an elevation above 20 000 m", { ...run, elevationGainM: 20000.5 }],
    ["a heart rate above 250", { ...run, averageHeartrate: 250.5 }],
    ["an array", [run]],
    [
      "a date after tomorrow",
      { ...run, startDate: "2026-11-01T00:00:00.000Z" },
    ],
    [
      "a distance above 500 km",
      { ...run, distanceM: 500_001, movingTimeS: 300_000 },
    ],
  ])("refuses %s", (_label, value) => {
    expect(validateImportedRun(value, NOW_MS)).toBeNull();
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
