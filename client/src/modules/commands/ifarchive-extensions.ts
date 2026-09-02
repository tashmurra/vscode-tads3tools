import axios = require("axios");
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";
import path = require("path");
import { pipeline, Transform } from "stream";
import { Open } from "unzipper";
import { ExtensionContext, MessageItem, window, workspace } from "vscode";
import { client } from "../../extension";
import { extensionState, ExtensionStateStore } from "../state";
import { ensureDirSync } from "fs-extra";

let extensionDownloadMap: Map<string, string>;

// Runtime bindings for external side effects so tests can override only what they need.
export type IfArchiveRuntimeFacade = {
  axiosGet: (url: string, config?: any) => Promise<any>;
  axiosRequest: (config: any) => Promise<any>;
  showQuickPick: typeof window.showQuickPick;
  showInformationMessage: typeof window.showInformationMessage;
  showErrorMessage: typeof window.showErrorMessage;
  getConfiguration: typeof workspace.getConfiguration;
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  copyFileSync: typeof copyFileSync;
  createWriteStream: typeof createWriteStream;
  mkdirSync: typeof mkdirSync;
  mkdtempSync: typeof mkdtempSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  unlinkSync: typeof unlinkSync;
  statSync: typeof statSync;
  ensureDirSync: typeof ensureDirSync;
  openZipFile: (path: string) => Promise<any>;
};

const productionRuntimeFacade: IfArchiveRuntimeFacade = {
  axiosGet: (url, config) => axios.get(url, config),
  axiosRequest: (config) => axios.request(config),
  showQuickPick: window.showQuickPick,
  showInformationMessage: window.showInformationMessage,
  showErrorMessage: window.showErrorMessage,
  getConfiguration: workspace.getConfiguration,
  existsSync,
  readdirSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  statSync,
  ensureDirSync,
  openZipFile: (zipPath) => Open.file(zipPath),
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2048;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;

export function validateArchiveFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed !== fileName ||
    /[\0-\x1f\x7f]/.test(trimmed) ||
    path.posix.basename(trimmed) !== trimmed ||
    path.win32.basename(trimmed) !== trimmed ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    throw new Error(`Unsafe archive filename: ${JSON.stringify(fileName)}`);
  }
  return trimmed;
}

export function resolveContainedFile(root: string, fileName: string): string {
  const safeName = validateArchiveFileName(fileName);
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, safeName);
  const relative = path.relative(absoluteRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Archive destination escapes its root: ${JSON.stringify(fileName)}`);
  }
  return candidate;
}

function requireHttpsUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "ifarchive.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`IF Archive downloads require the trusted https://ifarchive.org origin: ${url.toString()}`);
  }
  return url;
}

function buildDownloadUrl(baseUrl: string, fileName: string): string {
  const base = requireHttpsUrl(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const result = new URL(encodeURIComponent(validateArchiveFileName(fileName)), base);
  if (result.origin !== base.origin || result.protocol !== "https:") {
    throw new Error("Archive download URL changed origin or protocol");
  }
  return result.toString();
}

/**
 * Creates a runtime facade by layering test overrides on top of production bindings.
 */
function createRuntimeFacade(runtimeOverrides?: Partial<IfArchiveRuntimeFacade>): IfArchiveRuntimeFacade {
  return { ...productionRuntimeFacade, ...(runtimeOverrides ?? {}) };
}

function getMakefileDir(state: ExtensionStateStore): string {
  return dirname(
    state.isUsingTads2 ? state.getTads2MainFile()?.fsPath ?? "" : state.getChosenMakefileUri()?.fsPath ?? "",
  );
}

function buildInfoEntries(selections: readonly string[], downloadMap: Map<string, string>): string[] {
  return selections.map((extKey) => `${extKey} \n ${downloadMap.get(extKey)}`);
}

async function streamToWriter(readable: any, writer: any, maximumBytes: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let bytesReceived = 0;
    readable.on?.("data", (chunk: Buffer | string) => {
      bytesReceived += Buffer.byteLength(chunk);
      if (bytesReceived > maximumBytes) {
        readable.destroy?.(new Error(`Archive exceeds ${maximumBytes} bytes`));
        writer.destroy?.(new Error(`Archive exceeds ${maximumBytes} bytes`));
        reject(new Error(`Archive exceeds ${maximumBytes} bytes`));
      }
    });
    readable.on?.("error", reject);
    readable.pipe(writer);
    let error: Error | null = null;
    writer.on("error", (err: Error) => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on("close", () => {
      if (!error) {
        resolve();
      }
    });
  });
}

export function parseIfArchiveIndex(rawData: string): Map<string, string> {
  const entries = rawData.split("#");
  const parsedMap = new Map<string, string>();
  let idx = 0;
  for (const entry of entries) {
    const sections = entry.split(/\n+/);
    if (idx > 0 && sections[0]?.trim().length > 0) {
      const fileName = sections[0].trim();
      try {
        validateArchiveFileName(fileName);
        parsedMap.set(fileName, sections.splice(1).join("\n"));
      } catch {
        client.error(`Ignoring unsafe archive index entry: ${JSON.stringify(fileName)}`);
      }
    }
    idx++;
  }
  return parsedMap;
}

export async function downloadAndInstallExtension(
  _context: ExtensionContext,
  runtimeOverrides?: Partial<IfArchiveRuntimeFacade>,
) {
  const runtime = createRuntimeFacade(runtimeOverrides);
  const configuration = runtime.getConfiguration(extensionState.isUsingTads2 ? "tads2" : "tads3");
  const ifarchiveTads3ContributionsURL: string =
    configuration.get("ifArchiveExtensionURL") ??
    "https://ifarchive.org/if-archive/infocom/interpreters/tads3/contrib/";
  try {
    requireHttpsUrl(ifarchiveTads3ContributionsURL);
    const response = await runtime.axiosGet(ifarchiveTads3ContributionsURL, {
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_INDEX_BYTES,
      maxRedirects: 0,
    });
    extensionDownloadMap = parseIfArchiveIndex(response.data);
  } catch (err) {
    const dirExists = runtime.existsSync(extensionState.extensionCacheDirectory);
    const cachedDirs = dirExists ? runtime.readdirSync(extensionState.extensionCacheDirectory) : [];
    if (!dirExists || cachedDirs.length === 0) {
      const msg = `Failed downloading extension list and no local cache to use. Check internet connection: ${err}`;
      client.error(msg, undefined, true);
      return;
    }
    await performLocalExtensionInstallation(
      extensionState.extensionCacheDirectory,
      cachedDirs,
      extensionState,
      runtimeOverrides,
    );
    return;
  }

  const selections = await runtime.showQuickPick([...extensionDownloadMap.keys()], { canPickMany: true });
  if (selections === undefined || selections.length === 0) {
    return;
  }
  const option1: MessageItem = { title: "Install" };
  const infoEntries = buildInfoEntries(selections, extensionDownloadMap);

  const action = await runtime.showInformationMessage(infoEntries.join("\n\n***\n\n"), { modal: true }, option1);

  console.debug(`Choice: ${action}`);
  if (action?.title === "Install") {
    const makefileDir = getMakefileDir(extensionState);
    for (const extKey of selections) {
      const downloadURL = buildDownloadUrl(ifarchiveTads3ContributionsURL, extKey);
      try {
        await downloadAndCacheFile(
          downloadURL,
          makefileDir,
          extKey,
          extensionState.extensionCacheDirectory,
          runtimeOverrides,
        );
      } catch (err) {
        client.error(`Download failed for ${downloadURL}: ${err}`);
        runtime.showErrorMessage(`Download failed for ${downloadURL}: ${err}`);
        continue;
      }
      if (extKey.endsWith(".zip")) {
        const extensionPath = resolveContainedFile(makefileDir, extKey);
        const fileNameWithoutZipExt = extKey.substr(0, extKey.length - 4);
        const extensionInstalledDirname = resolveContainedFile(makefileDir, fileNameWithoutZipExt);
        client.info(`Unzipping ${extKey} to ${extensionInstalledDirname}`);
        await unzipFromFiletoFolder(extensionPath, extensionInstalledDirname, runtimeOverrides);
      }
      checkInstallRecipeFor(extKey);
    }
  }
}

export async function unzipFromFiletoFolder(
  zipFile: string,
  folderToUnzipTo: string,
  runtimeOverrides?: Partial<IfArchiveRuntimeFacade>,
) {
  const runtime = createRuntimeFacade(runtimeOverrides);
  try {
    if (runtime.statSync(zipFile).size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    const archive = await runtime.openZipFile(zipFile);
    if (archive.files.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
    }
    if (runtime.existsSync(folderToUnzipTo)) {
      throw new Error(`Refusing to extract over an existing path: ${folderToUnzipTo}`);
    }
    let declaredExtractedBytes = 0;
    for (const entry of archive.files) {
      const entryPath = String(entry.path ?? "").replace(/\\/g, "/");
      const normalized = path.posix.normalize(entryPath);
      if (
        !entryPath ||
        /[\0-\x1f\x7f]/.test(entryPath) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        path.posix.isAbsolute(normalized) ||
        path.win32.isAbsolute(entryPath)
      ) {
        throw new Error(`Unsafe path in archive: ${JSON.stringify(entry.path)}`);
      }
      if (entry.type && entry.type !== "File" && entry.type !== "Directory") {
        throw new Error(`Unsupported archive entry type: ${entry.type}`);
      }
      declaredExtractedBytes += Number(entry.vars?.uncompressedSize ?? 0);
      if (declaredExtractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`Expanded archive exceeds ${MAX_EXTRACTED_BYTES} bytes`);
      }
    }
    runtime.ensureDirSync(dirname(folderToUnzipTo));
    const stagingDirectory = runtime.mkdtempSync(`${folderToUnzipTo}.partial-`);
    let streamedBytes = 0;
    try {
      for (const entry of archive.files) {
        const entryPath = String(entry.path).replace(/\\/g, "/");
        const normalized = path.posix.normalize(entryPath);
        const destination = path.resolve(stagingDirectory, ...normalized.split("/"));
        const relative = path.relative(stagingDirectory, destination);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Archive entry escapes extraction root: ${JSON.stringify(entry.path)}`);
        }
        const isDirectory = entry.type === "Directory" || entryPath.endsWith("/");
        if (isDirectory) {
          runtime.mkdirSync(destination, { recursive: true, mode: 0o700 });
          continue;
        }
        if (typeof entry.stream !== "function") {
          throw new Error(`Archive entry cannot be streamed safely: ${JSON.stringify(entry.path)}`);
        }
        runtime.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const byteLimiter = new Transform({
          transform(chunk, _encoding, callback) {
            streamedBytes += Buffer.byteLength(chunk);
            if (streamedBytes > MAX_EXTRACTED_BYTES) {
              callback(new Error(`Expanded archive exceeds ${MAX_EXTRACTED_BYTES} bytes`));
            } else {
              callback(null, chunk);
            }
          },
        });
        await new Promise<void>((resolve, reject) => {
          pipeline(
            entry.stream(),
            byteLimiter,
            runtime.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
            (err) => (err ? reject(err) : resolve()),
          );
        });
      }
      if (runtime.existsSync(folderToUnzipTo)) {
        throw new Error(`Extraction destination appeared while installing: ${folderToUnzipTo}`);
      }
      runtime.renameSync(stagingDirectory, folderToUnzipTo);
    } catch (err) {
      runtime.rmSync(stagingDirectory, { recursive: true, force: true });
      throw err;
    }
    client.info(`Unzipping finished to folder: "${folderToUnzipTo}".`);
  } catch (err) {
    client.error(`Setting up readstream for ${zipFile} failed: ${err}`);
    throw err;
  }
}

export async function performLocalExtensionInstallation(
  extensionCacheDirectory: string,
  cachedDirs: string[],
  extensionState: ExtensionStateStore,
  runtimeOverrides?: Partial<IfArchiveRuntimeFacade>,
) {
  const runtime = createRuntimeFacade(runtimeOverrides);
  const selections = await runtime.showQuickPick(cachedDirs, {
    canPickMany: true,
    title: `[OFFLINE INSTALLER] (Select a cached library)`,
  });
  if (selections === undefined || selections.length === 0) {
    return;
  }
  const makefileDir = getMakefileDir(extensionState);
  for (const filename of selections) {
    validateArchiveFileName(filename);
    const fileNameWithoutZipExt = filename.substring(0, filename.length - 4);
    const extensionInstalledDirname = resolveContainedFile(makefileDir, fileNameWithoutZipExt);
    const pathToStoreExtension = resolveContainedFile(makefileDir, filename);
    const cachedFilePath = resolveContainedFile(extensionCacheDirectory, filename);
    if (runtime.existsSync(cachedFilePath)) {
      if (runtime.statSync(cachedFilePath).size > MAX_ARCHIVE_BYTES) {
        throw new Error(`Cached archive exceeds ${MAX_ARCHIVE_BYTES} bytes: ${filename}`);
      }
      runtime.copyFileSync(cachedFilePath, pathToStoreExtension);
    }
    if (pathToStoreExtension.endsWith(".zip")) {
      await unzipFromFiletoFolder(pathToStoreExtension, extensionInstalledDirname, runtimeOverrides);
    }
    checkInstallRecipeFor(filename);
  }
}

export async function downloadAndCacheFile(
  requestUrl: string,
  folder: string,
  fileName: string,
  extensionCacheDirectory: string,
  runtimeOverrides?: Partial<IfArchiveRuntimeFacade>,
) {
  const runtime = createRuntimeFacade(runtimeOverrides);
  requireHttpsUrl(requestUrl);
  runtime.ensureDirSync(extensionCacheDirectory);
  const cachedFilePath = resolveContainedFile(extensionCacheDirectory, fileName);
  const pathToStoreExtension = resolveContainedFile(folder, fileName);
  if (runtime.existsSync(cachedFilePath)) {
    if (runtime.statSync(cachedFilePath).size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Cached archive exceeds ${MAX_ARCHIVE_BYTES} bytes: ${fileName}`);
    }
    runtime.copyFileSync(cachedFilePath, pathToStoreExtension);
    client.info(`Reusing cached file ${cachedFilePath}`);
    return;
  }
  const response = await runtime.axiosRequest({
    method: "get",
    url: requestUrl,
    responseType: "stream",
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: MAX_ARCHIVE_BYTES,
    maxBodyLength: MAX_ARCHIVE_BYTES,
    maxRedirects: 0,
  });
  const contentLength = Number(response.headers?.["content-length"] ?? 0);
  if (contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const partialPath = `${pathToStoreExtension}.part`;
  const writer = runtime.createWriteStream(partialPath, { flags: "wx" });
  try {
    await streamToWriter(response.data, writer, MAX_ARCHIVE_BYTES);
    runtime.renameSync(partialPath, pathToStoreExtension);
    runtime.copyFileSync(pathToStoreExtension, cachedFilePath);
    client.info(`Download of ${fileName} to folder "${folder}" is completed`);
  } catch (err: any) {
    client.error(err?.message ?? String(err));
    if (runtime.existsSync(partialPath)) runtime.unlinkSync(partialPath);
    throw err;
  }
}

/**
 * A function that checks install recipies for certain supported extensions,
 * and does the tweaking necessary with the makefile to get it up and running
 * @param selections
 */
function checkInstallRecipeFor(selections: string) {
  // TODO: Yet to be written
}
