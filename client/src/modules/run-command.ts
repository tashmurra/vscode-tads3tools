import { execFile } from "child_process";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 50 * 1024 * 1024;

export function runCommand(executable: string, args: readonly string[] = []): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES, timeout: COMMAND_TIMEOUT_MS },
      (_error, stdout) => resolve(stdout ?? ""),
    );
  });
}
