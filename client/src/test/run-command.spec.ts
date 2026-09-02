/* eslint-disable @typescript-eslint/no-var-requires */
import { expect, describe } from "@jest/globals";
import { runCommand } from "../modules/run-command";

// Skipping beacuse it requires t3make to be installed
describe("runCommand", () => {
  test("runCommand executes a program directly", async () => {
    // Arrange, Act
    const resultOfLs = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);

    // Assert
    expect(resultOfLs).not.toBeUndefined();
    expect(resultOfLs).toBe("ok");
  });

  test("runCommand treats shell metacharacters as arguments", async () => {
    const marker = "$(printf injected)";
    const output = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker]);

    expect(output).toBe(marker);
  });

  test("runCommand fails to recognize the unknown command 'slartibartfast123'", async () => {
    // Arrange, Act, Assert
    expect((await runCommand("slartibartfast123")) as string).toBe("");
  });
});
