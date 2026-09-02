import { expect, describe, test } from "@jest/globals";
import {
  isParseInputWithinLimit,
  limitProjectParseInputs,
  MAX_PARSE_INPUT_CHARS,
  MAX_PROJECT_PARSE_CHARS,
  MAX_PROJECT_PARSE_FILES,
  withWorkerTimeout,
} from "../../src/modules/parse-limits";

describe("parse resource limits", () => {
  test("accepts ordinary source input", () => {
    expect(isParseInputWithinLimit("class Example: object;")) .toBe(true);
  });

  test("rejects input above the parser size limit", () => {
    expect(isParseInputWithinLimit("x".repeat(MAX_PARSE_INPUT_CHARS + 1))).toBe(false);
  });

  test("bounds aggregate project parser input", () => {
    const paths = Array.from({ length: MAX_PROJECT_PARSE_CHARS / MAX_PARSE_INPUT_CHARS + 1 }, (_, i) => `${i}.t`);
    const chunk = "x".repeat(MAX_PARSE_INPUT_CHARS);

    expect(limitProjectParseInputs(paths, () => chunk)).toEqual({
      accepted: paths.slice(0, -1),
      skipped: paths.slice(-1),
    });
  });

  test("deduplicates paths and bounds projects containing many empty files", () => {
    const paths = Array.from({ length: MAX_PROJECT_PARSE_FILES + 1 }, (_, i) => `${i}.t`);
    const result = limitProjectParseInputs([paths[0], paths[0], ...paths.slice(1)], () => "");

    expect(result.accepted).toHaveLength(MAX_PROJECT_PARSE_FILES);
    expect(result.accepted.filter((path) => path === paths[0])).toHaveLength(1);
    expect(result.skipped).toEqual([paths[MAX_PROJECT_PARSE_FILES]]);
  });

  test("rejects active parser work when cancellation is requested", async () => {
    let cancelled = false;
    const neverFinishes = new Promise<never>(() => undefined);
    setTimeout(() => { cancelled = true; }, 10);

    await expect(withWorkerTimeout(neverFinishes, "fixture.t", () => cancelled)).rejects.toThrow(
      "CANCELLED while parsing fixture.t",
    );
  });
});
