import { describe, expect, it } from "vitest";
import { fromKop, parseRub, toKop } from "../src/utils/money.js";

describe("parseRub", () => {
  it("принимает число и строку с числом", () => {
    expect(parseRub(2500)).toBe(2500);
    expect(parseRub("2500.00")).toBe(2500);
    expect(parseRub(" 99 ")).toBe(99);
  });

  it("отклоняет мусор и отрицательные суммы", () => {
    expect(() => parseRub("abc")).toThrow();
    expect(() => parseRub(null)).toThrow();
    expect(() => parseRub(-1)).toThrow();
  });
});

describe("toKop / fromKop", () => {
  it("рубли в копейки", () => {
    expect(toKop(2500)).toBe(250000);
    expect(toKop(99)).toBe(9900);
  });

  it("отбрасывает доли копейки", () => {
    expect(toKop(10.999)).toBe(1099);
  });

  it("копейки в рубли", () => {
    expect(fromKop(250000)).toBe(2500);
    expect(fromKop(1099)).toBe(10.99);
  });

  it.each([1.15, 19.99, 545.49, 2364.06, 7766.43])("preserves exact kopecks for %s", (rub) => {
    expect(toKop(rub)).toBe(Math.round(rub * 100));
  });

  it("handles scientific notation and actual fractional kopecks", () => {
    expect(toKop(1e-7)).toBe(0);
    expect(toKop(1.15999)).toBe(115);
    expect(toKop(0)).toBe(0);
    expect(toKop(1e10)).toBe(1e12);
  });

  it("rejects invalid or unsafe money", () => {
    for (const value of ["", "  ", "0x10", "Infinity"]) expect(() => parseRub(value)).toThrow();
    for (const value of [NaN, Infinity, -1, 1e20]) expect(() => toKop(value)).toThrow();
    expect(() => fromKop(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
