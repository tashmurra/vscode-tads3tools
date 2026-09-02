import { spawn, Worker, Thread } from "threads";
import { connection } from "./server";
import { clearCompletionCache } from "./modules/completions";
import { symbolManager } from "./modules/symbol-manager";
import { serverState } from './state';
import { limitProjectParseInputs, MAX_PARSE_INPUT_CHARS, withWorkerTimeout } from "./modules/parse-limits";

const SLOW_FILE_THRESHOLD_MS = 5000;

function logTads2ParseInfo(parseInfo: any) {
  if (!parseInfo) return;
  const { fileName, totalTimeMs, lexTimeMs, parseTimeMs, walkTimeMs, textLength, symbolCount, warnings, walkError, parsingMode } = parseInfo;
  connection.console.debug(
    `[parse-t2] ${fileName}: ${totalTimeMs}ms total (lex: ${lexTimeMs}ms, parse: ${parseTimeMs}ms, walk: ${walkTimeMs}ms) | mode: ${parsingMode} | ${textLength} chars, ${symbolCount} symbols`
  );
  if (totalTimeMs > SLOW_FILE_THRESHOLD_MS) {
    connection.console.warn(
      `[parse-t2] SLOW FILE: ${fileName} took ${totalTimeMs}ms (threshold: ${SLOW_FILE_THRESHOLD_MS}ms)`
    );
  }
  if (warnings && warnings.length > 0) {
    for (const warning of warnings) {
      connection.console.warn(`[parse-t2] ${warning}`);
    }
  }
  if (walkError) {
    connection.console.error(`[parse-t2] ${walkError}`);
  }
}

export async function parseTads2Files(filePaths: string[] | undefined = [], token?: any) {
  //const parseOnlyTheWorkspaceFiles: boolean = await connection.workspace.getConfiguration("tads3.parseOnlyTheWorkspaceFiles");

  const startTime = Date.now();
  if (token?.isCancellationRequested) return;
  const requestedFilePaths = filePaths.length === 0 ? [...serverState.preprocessedFilesCacheMap.keys()] : filePaths;
  const limitedInputs = limitProjectParseInputs(
    requestedFilePaths,
    (filePath) => serverState.preprocessedFilesCacheMap.get(filePath) ?? "",
  );
  const allFilePaths = limitedInputs.accepted;
  for (const filePath of limitedInputs.skipped) {
    connection.console.warn(`[parse-t2] Skipping ${filePath}: parser size budget exceeded (${MAX_PARSE_INPUT_CHARS} characters per file)`);
  }
  const totalFiles = allFilePaths.length;
  let tracker = 0;

  if (allFilePaths.length === 0) {
    await connection.sendNotification("symbolparsing/allfiles/success", { allFilePaths, elapsedTime: 0 });
    return;
  }

  // Parse everything if no files are specified
  if (allFilePaths.length === 1) {
    const filePath = allFilePaths[0];
    const startTime = Date.now();
    connection.console.debug(`Spawning worker to parse a single file: ${filePath}`);

    await connection.sendNotification("symbolparsing/processing", [filePath, 0, totalFiles, 1]);
    const worker = await spawn(new Worker("./tads2-parse-worker"));
    const text = serverState.preprocessedFilesCacheMap.get(filePath) ?? "";
    let jobResult: any;
    try {
      jobResult = await withWorkerTimeout(
        worker(filePath, text),
        `${filePath} (${text.length} chars)`,
        () => !!token?.isCancellationRequested,
      );
    } catch (err) {
      connection.console.error(`[parse-t2] FAILED: ${filePath} — ${err}`);
      await Thread.terminate(worker);
      await connection.sendNotification("symbolparsing/allfiles/failed", { error: String(err) });
      return;
    }

    connection.console.debug(`Worker finished with result`);
    const { symbols, keywords, mapData, additionalProperties, inheritanceMap, parseInfo } = jobResult;
    logTads2ParseInfo(parseInfo);
    symbolManager.symbols.set(filePath, symbols ?? []);
    symbolManager.keywords.set(filePath, keywords ?? []);
    inheritanceMap.forEach((value: string, key: string) => symbolManager.inheritanceMap.set(key, value));
    mapData.forEach((value: any, key: string) => symbolManager.mapData.set(key, value));
    clearCompletionCache();
    symbolManager.additionalProperties.set(filePath, additionalProperties);
    tracker++;
    const elapsedTime = Date.now() - startTime;
    await connection.sendNotification("symbolparsing/success", [filePath, tracker, totalFiles, 1]);
    connection.console.debug(`${filePath} parsed successfully in ${elapsedTime} ms`);
    try {
      await Thread.terminate(worker);
      connection.console.debug(`[worker unassigned]`);
    } catch (err) {
      connection.console.error(`Error during thread termination: ${err}`);
    }
  } else {
    const maxNumberOfParseWorkerThreads: number = await connection.workspace.getConfiguration(
      "tads3.maxNumberOfParseWorkerThreads",
    );
    connection.console.debug(`Preparing to parse a total of ${allFilePaths.length} files`);
    const configuredWorkerCount = Number(maxNumberOfParseWorkerThreads);
    const safeWorkerCount = Number.isInteger(configuredWorkerCount) && configuredWorkerCount > 0 ? configuredWorkerCount : 1;
    const poolSize = Math.min(allFilePaths.length, safeWorkerCount);
    connection.console.debug(`Setting worker concurrency to: ${poolSize}`);
    let nextFileIndex = 0;
    const consumeFiles = async () => {
      while (nextFileIndex < allFilePaths.length && !token?.isCancellationRequested) {
        const filePath = allFilePaths[nextFileIndex++];
        await connection.sendNotification("symbolparsing/processing", [filePath, tracker, totalFiles, poolSize]);
        const text = serverState.preprocessedFilesCacheMap.get(filePath) ?? "";
        const worker = await spawn(new Worker("./tads2-parse-worker"));
        try {
          const { symbols, keywords, mapData, additionalProperties, inheritanceMap, parseInfo } =
            await withWorkerTimeout(
              worker(filePath, text),
              `${filePath} (${text.length} chars)`,
              () => !!token?.isCancellationRequested,
            );
          logTads2ParseInfo(parseInfo);
          symbolManager.symbols.set(filePath, symbols ?? []);
          symbolManager.keywords.set(filePath, keywords ?? []);
          inheritanceMap.forEach((value: string, key: string) => symbolManager.inheritanceMap.set(key, value));
          mapData.forEach((value: any, key: string) => symbolManager.mapData.set(key, value));
          clearCompletionCache();
          symbolManager.additionalProperties.set(filePath, additionalProperties);
        } catch (err) {
          connection.console.error(`[parse-t2] FAILED: ${filePath} — ${err}`);
        } finally {
          try {
            await Thread.terminate(worker);
          } catch (err) {
            connection.console.error(`Error during thread termination: ${err}`);
          }
        }
        tracker++;
        await connection.sendNotification("symbolparsing/success", [filePath, tracker, totalFiles, poolSize]);
        connection.console.debug(`${filePath} parsed successfully`);
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => consumeFiles()));

    const elapsedTime = Date.now() - startTime;
    console.debug(`All files parsed within ${elapsedTime} ms`);
    await connection.sendNotification("symbolparsing/allfiles/success", {
      allFilePaths,
      elapsedTime,
    });
  }
}
