import { dirname, basename } from "path";
import { workspace, RelativePattern, window } from "vscode";
import { debounceTime } from "rxjs";
import { client, runGameInTerminalSubject, DEBOUNCE_TIME, findImageByPattern } from "../extension";

export function parseInterpreterCommand(command: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("Interpreter setting contains an unmatched quote");
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Interpreter setting is empty");

  return { executable: tokens[0], args: tokens.slice(1) };
}

export function setupAndMonitorBinaryGamefileChanges(extensionState: any, imageFormat: string): void {
  if (!extensionState.getUsingTads2() && extensionState.imageInfoProvider) {
    findImageByPattern(false).then((filepath) => {
      if (filepath) {
        extensionState.imageInfoProvider.update(filepath);
      } else {
        client.warn(`No .t3 file found in workspace to monitor for changes. Please add a .t3 file or use the "Analyze T3 Image" command to select a file to monitor.`);
      }
    });
  }

  if (extensionState.gameFileSystemWatcher !== undefined) {
    return;
  }
  if (extensionState.gameFileSystemWatcher !== undefined) {
    return;
  }

  client.info(`setup and monitor binary game file changes. `);

  const workspaceFolder = extensionState.getUsingTads2()
    ? dirname(extensionState.getTads2MainFile().fsPath)
    : dirname(extensionState.getChosenMakefileUri().fsPath);

  const gameFileSystemWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceFolder, imageFormat));

  runGameInTerminalSubject.pipe(debounceTime(DEBOUNCE_TIME)).subscribe((event: any) => {
    const configuration = workspace.getConfiguration("tads3");

    if (!configuration.get("restartGameRunnerOnT3ImageChanges")) {
      return;
    }
    // TODO: right now autmatic script generation is only compatible with t3run.exe (windows)
    // which has the -o flag to capture both input to a file. Frob misses that.
    // Closest yet with frob is logging output but i doesn't capture input regardless plain mode etc:
    // "frob -p -c  -i plain -R scripts/tmp.cmd gameMain.t3 1>&1 | tee scripts/auto.cmd"
    const enableScriptFiles: boolean = configuration.get("enableScriptFiles");
    const gameRunnerInterpreter: string = configuration.get("gameRunnerInterpreter") ?? "";
    const logToFileEnabled = process.platform === "win32" && gameRunnerInterpreter.match("t3run.exe");
    const interpreterArgs = enableScriptFiles && logToFileEnabled
      ? ["-o", `scripts/Auto ${extensionState.autoScriptFileSerial + 1}.cmd`]
      : [];
    startGameWithInterpreter(event.fsPath, interpreterArgs);
  });

  gameFileSystemWatcher.onDidChange((event) => runGameInTerminalSubject.next(event));
  extensionState.gameFileSystemWatcher = gameFileSystemWatcher;
}

export function closeAllTerminalsNamed(name: string) {
  const gameRunnerTerminals = window.terminals.filter((x) => x.name === name);
  for (const gameRunnerTerminal of gameRunnerTerminals) {
    client.info(`Dispose previous game runner terminal`);
    gameRunnerTerminal.sendText(`quit`);
    gameRunnerTerminal.sendText(`y`);
    gameRunnerTerminal.sendText(``);
    //gameRunnerTerminal.sendText(`\u001c`);
    gameRunnerTerminal.dispose();
  }
}

export function startGameWithInterpreter(filepath: string, interpreterArgs: string[] = []): void {
  const configuration = workspace.getConfiguration("tads3");
  const interpreter: string | undefined = configuration.get("gameRunnerInterpreter");

  if (!interpreter) {
    window.showErrorMessage(`Interpreter setting missing. Examine setting tads3.gameRunnerInterpreter`);
    return;
  }

  let interpreterCommand: { executable: string; args: string[] };
  try {
    interpreterCommand = parseInterpreterCommand(interpreter);
  } catch (error) {
    window.showErrorMessage(`Invalid interpreter setting: ${error}`);
    return;
  }
  const fileBaseName = basename(filepath);
  closeAllTerminalsNamed("Tads3 Game runner terminal");

  const gameRunnerTerminal = window.createTerminal({
    name: "Tads3 Game runner terminal",
    shellPath: interpreterCommand.executable,
    shellArgs: [...interpreterCommand.args, ...interpreterArgs, fileBaseName],
    cwd: dirname(filepath),
  });
  client.info(`${filepath} changed, restarting ${fileBaseName} in game runner terminal`);

  // FIXME: preserveFocus doesn't work, the terminal takes focus anyway (might be because of sendText)
  gameRunnerTerminal.show(true);
  // FIXME: Interim hack to make preserveFocus work even when there's a slow startup of the interpreter
  // (This won't always work, especially on a slow machine)
  const documentWorkingOn = window.activeTextEditor.document;
  setTimeout(() => window.showTextDocument(documentWorkingOn), 500);
}

export async function toggleRunnerOnChanges() {
  const configuration = workspace.getConfiguration("tads3");
  const oldValue = configuration.get("restartGameRunnerOnT3ImageChanges");
  configuration.update("restartGameRunnerOnT3ImageChanges", !oldValue, true);
}
