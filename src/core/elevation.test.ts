import { describe, expect, it } from "vitest";
import { elevationPerKm } from "./elevation";

describe("elevationPerKm", () => {
  it("divides the elevation gain by the distance in km", () => {
    expect(elevationPerKm(180, 10000)).toBe(18);
  });

  it("rounds to the nearest metre per km", () => {
    expect(elevationPerKm(245, 8450)).toBe(29); // 28,99…
    expect(elevationPerKm(125, 10000)).toBe(13); // 12,5
    expect(elevationPerKm(124, 10000)).toBe(12); // 12,4
  });

  it("rounds an exact half up even when km is not exact in binary", () => {
    expect(elevationPerKm(7, 560)).toBe(13); // 12,5
    expect(elevationPerKm(33, 4400)).toBe(8); // 7,5
    expect(elevationPerKm(21, 560)).toBe(38); // 37,5
  });

  it("is zero on a flat run", () => {
    expect(elevationPerKm(0, 10000)).toBe(0);
  });

  it("is null for a zero distance", () => {
    expect(elevationPerKm(50, 0)).toBeNull();
    expect(elevationPerKm(0, 0)).toBeNull();
  });

  it("is null when the elevation gain is unknown", () => {
    expect(elevationPerKm(null, 10000)).toBeNull();
  });

  it("is null for a negative distance", () => {
    expect(elevationPerKm(50, -1000)).toBeNull();
  });

  it("keeps a large ratio on a very short and steep run", () => {
    expect(elevationPerKm(500, 1000)).toBe(500);
    expect(elevationPerKm(1, 1)).toBe(1000);
  });
});
