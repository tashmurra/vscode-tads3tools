import { describe, expect, test } from "@jest/globals";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Tads3Runtime } from "../tads3Runtime";

const fileAccessor = {
  isWindows: false,
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
};

describe("Tads3Runtime transport security", () => {
  test("rejects unauthenticated TCP debugger transport before spawning", async () => {
    const runtime = new Tads3Runtime(fileAccessor);

    await expect(runtime.start("/tmp/game.t3", "frobd", true, "tcp")).rejects.toThrow(
      "TCP DAP mode is disabled",
    );
  });

  test("terminates frobd when its private socket never becomes ready", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "tads-runtime-test-"));
    const executable = join(fixtureDirectory, "frobd-stub");
    writeFileSync(
      executable,
      "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
    );
    chmodSync(executable, 0o700);
    const runtime = new Tads3Runtime(fileAccessor);
    (runtime as any)._socketReadyRetries = 20;
    (runtime as any)._socketReadyDelayMs = 10;

    try {
      await expect(runtime.start("/tmp/game.t3", executable, true)).rejects.toThrow(
        "did not create its private DAP socket",
      );
      expect((runtime as any)._frobdProcess.killed).toBe(true);
      expect((runtime as any)._frobdProcess.exitCode !== null || (runtime as any)._frobdProcess.signalCode !== null).toBe(true);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
