import { describe, expect, test } from "@jest/globals";
import { runCommand } from "../../src/parser/preprocessor";

describe("preprocessor process execution security", () => {
  test("passes shell metacharacters as literal arguments", async () => {
    const marker = "$(printf injected);`whoami`";
    const output = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      marker,
    ]);

    expect(output).toBe(marker);
  });

  test("terminates preprocessing when cancellation is requested", async () => {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 25);
    const startedAt = Date.now();

    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"], () => cancelled),
    ).rejects.toThrow("CANCELLED while preprocessing");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
