/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, expect, test, jest } from "@jest/globals";

jest.mock("vscode");
jest.mock("../../src/extension", () => ({
  client: { info: jest.fn(), warn: jest.fn() },
  runGameInTerminalSubject: { pipe: jest.fn(() => ({ subscribe: jest.fn() })) },
  DEBOUNCE_TIME: 10,
  findImageByPattern: jest.fn(),
}));

const { window, workspace } = require("vscode");
import { parseInterpreterCommand, startGameWithInterpreter } from "../modules/game-monitor";

describe("game runner command parsing", () => {
  test("preserves documented interpreter arguments without invoking a shell", () => {
    expect(parseInterpreterCommand('"C:\\Program Files\\TADS\\t3run.exe" -plain')).toEqual({
      executable: "C:\\Program Files\\TADS\\t3run.exe",
      args: ["-plain"],
    });
  });

  test("treats shell metacharacters as literal argument text", () => {
    expect(parseInterpreterCommand("frob '$(touch marker)'" )).toEqual({
      executable: "frob",
      args: ["$(touch marker)"],
    });
  });

  test("starts the interpreter as the terminal process instead of submitting a shell command", () => {
    jest.useFakeTimers();
    const terminal = { show: jest.fn(), sendText: jest.fn(), dispose: jest.fn() };
    window.createTerminal.mockReturnValue(terminal);
    window.terminals = [];
    workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => key === "gameRunnerInterpreter" ? "t3run.exe -plain" : undefined),
    });

    startGameWithInterpreter("/project/My Game.t3");

    expect(window.createTerminal).toHaveBeenCalledWith({
      name: "Tads3 Game runner terminal",
      shellPath: "t3run.exe",
      shellArgs: ["-plain", "My Game.t3"],
      cwd: "/project",
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
});
