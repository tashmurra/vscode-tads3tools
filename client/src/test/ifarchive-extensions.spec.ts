/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, expect, jest } from "@jest/globals";
import { Readable, Writable } from "stream";

jest.mock("vscode");

jest.mock("../../src/extension", () => {
  return {
    client: {
      info: jest.fn(),
      error: jest.fn(),
    },
  };
});

jest.mock("../../src/modules/state", () => {
  return {
    extensionState: {
      isUsingTads2: false,
      extensionCacheDirectory: "/cache",
      getChosenMakefileUri: jest.fn(() => ({ fsPath: "/project/Makefile.t3m" })),
      getTads2MainFile: jest.fn(() => ({ fsPath: "/project/main.t" })),
    },
    ExtensionStateStore: jest.fn(),
  };
});

jest.mock("axios", () => {
  const axiosFn: any = jest.fn();
  axiosFn.get = jest.fn();
  axiosFn.request = jest.fn();
  return axiosFn;
});

jest.mock("fs-extra", () => {
  return {
    ensureDirSync: jest.fn(),
  };
});

jest.mock("unzipper", () => {
  return {
    Open: { file: jest.fn() },
  };
});

jest.mock("fs", () => {
  return {
    copyFileSync: jest.fn(),
    renameSync: jest.fn(),
    mkdirSync: jest.fn(),
    mkdtempSync: jest.fn((prefix: string) => `${prefix}test`),
    rmSync: jest.fn(),
    unlinkSync: jest.fn(),
    statSync: jest.fn(() => ({ size: 100 })),
    createReadStream: jest.fn(() => {
      const handlers: Record<string, (...args: any[]) => void> = {};
      return {
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return this;
        }),
        pipe: jest.fn(),
        __handlers: handlers,
      };
    }),
    createWriteStream: jest.fn(() => {
      return {
        on: jest.fn(),
        close: jest.fn(),
      };
    }),
    existsSync: jest.fn(),
    readdirSync: jest.fn(),
  };
});

const axios = require("axios");
const { window, workspace } = require("vscode");
const { client } = require("../../src/extension");
const { extensionState } = require("../../src/modules/state");
const { existsSync, readdirSync, copyFileSync, createReadStream, renameSync, unlinkSync, statSync, mkdirSync, mkdtempSync, rmSync } = require("fs");
const { ensureDirSync } = require("fs-extra");
const { Open } = require("unzipper");

import {
  downloadAndCacheFile,
  downloadAndInstallExtension,
  parseIfArchiveIndex,
  performLocalExtensionInstallation,
  resolveContainedFile,
  unzipFromFiletoFolder,
  validateArchiveFileName,
} from "../modules/commands/ifarchive-extensions";

function createDepsForDownloadAndCacheFile() {
  const writerHandlers: Record<string, (...args: any[]) => void> = {};
  const writer = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      writerHandlers[event] = handler;
      return writer;
    }),
    close: jest.fn(),
    destroy: jest.fn(),
  };
  const readableHandlers: Record<string, (...args: any[]) => void> = {};
  const readable = {
    pipe: jest.fn(),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      readableHandlers[event] = handler;
      return readable;
    }),
    destroy: jest.fn(),
  };

  const deps = {
    ensureDirSync: jest.fn(),
    existsSync: jest.fn(),
    copyFileSync: jest.fn(),
    createWriteStream: jest.fn(() => writer),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
    statSync: jest.fn(() => ({ size: 100 })),
    axiosRequest: jest.fn(async () => ({ data: readable })),
  };

  return {
    deps,
    writer,
    writerHandlers,
    readable,
    readableHandlers,
  };
}

describe("ifarchive-extensions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockReset();
    axios.request.mockReset();
    existsSync.mockReset();
    readdirSync.mockReset();
    copyFileSync.mockReset();
    createReadStream.mockReset();
    renameSync.mockReset();
    mkdirSync.mockReset();
    mkdtempSync.mockReset();
    rmSync.mockReset();
    unlinkSync.mockReset();
    statSync.mockReset();
    ensureDirSync.mockReset();
    Open.file.mockReset();

    statSync.mockReturnValue({ size: 100 });
    mkdtempSync.mockImplementation((prefix: string) => `${prefix}test`);
    Open.file.mockResolvedValue({ files: [] });
    createReadStream.mockImplementation(() => {
      const handlers: Record<string, (...args: any[]) => void> = {};
      return {
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return this;
        }),
        pipe: jest.fn(),
        __handlers: handlers,
      };
    });

    workspace.getConfiguration.mockReturnValue({
      get: jest.fn(() => "https://ifarchive.org/contrib/"),
      update: jest.fn(),
    });
    extensionState.isUsingTads2 = false;
    extensionState.extensionCacheDirectory = "/cache";
    extensionState.getChosenMakefileUri.mockReturnValue({ fsPath: "/project/Makefile.t3m" });
    extensionState.getTads2MainFile.mockReturnValue({ fsPath: "/project/main.t" });
    window.showQuickPick.mockResolvedValue(undefined);
    window.showInformationMessage.mockResolvedValue(undefined);
  });

  test("falls back with an error when extension list fetch fails and no cache exists", async () => {
    axios.get.mockRejectedValueOnce(new Error("offline"));
    existsSync.mockReturnValue(false);

    await downloadAndInstallExtension({} as any);

    expect(client.error).toHaveBeenCalledTimes(1);
    expect(String(client.error.mock.calls[0][0])).toContain("Failed downloading extension list and no local cache to use");
    expect(window.showQuickPick).toHaveBeenCalledTimes(0);
  });

  test("parseIfArchiveIndex parses entries and ignores empty header section", () => {
    const parsed = parseIfArchiveIndex("#foo.zip\nDesc one\nline2#bar.t\nDesc two");

    expect(parsed.size).toBe(2);
    expect(parsed.get("foo.zip")).toBe("Desc one\nline2");
    expect(parsed.get("bar.t")).toBe("Desc two");
  });

  test("parseIfArchiveIndex excludes traversal entries", () => {
    const parsed = parseIfArchiveIndex("#../escape.zip\nBad#safe.zip\nGood");

    expect([...parsed.keys()]).toEqual(["safe.zip"]);
  });

  for (const fileName of ["../escape.zip", "..\\escape.zip", "/tmp/escape.zip", "C:\\escape.zip", "bad\0.zip"]) {
    test(`rejects unsafe archive filename ${JSON.stringify(fileName)}`, () => {
      expect(() => validateArchiveFileName(fileName)).toThrow("Unsafe archive filename");
      expect(() => resolveContainedFile("/project", fileName)).toThrow();
    });
  }

  test("downloadAndCacheFile reuses cached file when available", async () => {
    const { deps } = createDepsForDownloadAndCacheFile();
    deps.existsSync.mockReturnValue(true);

    await downloadAndCacheFile("https://ifarchive.org/y.zip", "/project", "y.zip", "/cache", deps as any);

    expect(deps.ensureDirSync).toHaveBeenCalledWith("/cache");
    expect(deps.copyFileSync).toHaveBeenCalledWith("/cache/y.zip", "/project/y.zip");
    expect(deps.axiosRequest).toHaveBeenCalledTimes(0);
    expect(client.info).toHaveBeenCalledWith("Reusing cached file /cache/y.zip");
  });

  test("downloadAndCacheFile rejects plaintext HTTP before filesystem access", async () => {
    const { deps } = createDepsForDownloadAndCacheFile();

    await expect(downloadAndCacheFile("http://x/y.zip", "/project", "y.zip", "/cache", deps as any)).rejects.toThrow(
      "trusted https://ifarchive.org origin",
    );
    expect(deps.createWriteStream).not.toHaveBeenCalled();
    expect(deps.axiosRequest).not.toHaveBeenCalled();
  });

  test("downloadAndCacheFile rejects an untrusted HTTPS origin before filesystem access", async () => {
    const { deps } = createDepsForDownloadAndCacheFile();

    await expect(
      downloadAndCacheFile("https://attacker.example/y.zip", "/project", "y.zip", "/cache", deps as any),
    ).rejects.toThrow("trusted https://ifarchive.org origin");
    expect(deps.createWriteStream).not.toHaveBeenCalled();
    expect(deps.axiosRequest).not.toHaveBeenCalled();
  });

  test("downloadAndCacheFile rejects oversized responses before creating a file", async () => {
    const { deps, readable } = createDepsForDownloadAndCacheFile();
    deps.existsSync.mockReturnValue(false);
    deps.axiosRequest.mockResolvedValueOnce({
      data: readable,
      headers: { "content-length": String(26 * 1024 * 1024) },
    } as any);

    await expect(downloadAndCacheFile("https://ifarchive.org/y.zip", "/project", "y.zip", "/cache", deps as any)).rejects.toThrow(
      "Archive exceeds",
    );
    expect(deps.createWriteStream).not.toHaveBeenCalled();
  });

  test("downloadAndCacheFile downloads and stores file when cache is missing", async () => {
    const { deps, writerHandlers, readable } = createDepsForDownloadAndCacheFile();
    deps.existsSync.mockReturnValue(false);

    const downloadPromise = downloadAndCacheFile("https://ifarchive.org/z.zip", "/project", "z.zip", "/cache", deps as any);

    await Promise.resolve();

    expect(deps.axiosRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "get", url: "https://ifarchive.org/z.zip", responseType: "stream", maxRedirects: 0,
    }));
    expect(readable.pipe).toHaveBeenCalledTimes(1);
    writerHandlers.close();
    await downloadPromise;

    expect(deps.createWriteStream).toHaveBeenCalledWith("/project/z.zip.part", { flags: "wx" });
    expect(deps.renameSync).toHaveBeenCalledWith("/project/z.zip.part", "/project/z.zip");
    expect(deps.copyFileSync).toHaveBeenCalledWith("/project/z.zip", "/cache/z.zip");
    expect(client.info).toHaveBeenCalledWith('Download of z.zip to folder "/project" is completed');
  });

  test("downloadAndCacheFile logs stream errors and closes writer", async () => {
    const { deps, writerHandlers } = createDepsForDownloadAndCacheFile();
    deps.existsSync.mockReturnValue(false);

    const downloadPromise = downloadAndCacheFile("https://ifarchive.org/w.zip", "/project", "w.zip", "/cache", deps as any);

    await Promise.resolve();

    const streamError = new Error("stream failed");
    writerHandlers.error(streamError);
    await expect(downloadPromise).rejects.toThrow("stream failed");

    expect(deps.copyFileSync).toHaveBeenCalledTimes(0);
    expect(client.error).toHaveBeenCalledWith("stream failed");
  });

  test("uses offline installer quick pick when extension list fetch fails but cache exists", async () => {
    axios.get.mockRejectedValueOnce(new Error("offline"));
    existsSync.mockImplementation((targetPath: string) => targetPath === "/cache");
    readdirSync.mockReturnValue(["cached.zip"]);

    await downloadAndInstallExtension({} as any);

    expect(window.showQuickPick).toHaveBeenCalledWith(["cached.zip"],
      expect.objectContaining({ title: "[OFFLINE INSTALLER] (Select a cached library)" }));
  });

  test("online listing returns early when no extension is selected", async () => {
    const runtime = {
      axiosGet: jest.fn(async () => ({ data: "#one.zip\nDesc one" })),
      showQuickPick: jest.fn(async () => undefined),
      showInformationMessage: jest.fn(),
    };

    await downloadAndInstallExtension({} as any, runtime as any);

    expect(runtime.showQuickPick).toHaveBeenCalledWith(["one.zip"], { canPickMany: true });
    expect(runtime.showInformationMessage).toHaveBeenCalledTimes(0);
  });

  test("online listing shows modal info and aborts when action is not Install", async () => {
    const runtime = {
      axiosGet: jest.fn(async () => ({ data: "#one.zip\nDesc one" })),
      showQuickPick: jest.fn(async () => ["one.zip"]),
      showInformationMessage: jest.fn(async () => ({ title: "Abort" })),
    };

    await downloadAndInstallExtension({} as any, runtime as any);

    expect(runtime.showInformationMessage).toHaveBeenCalledWith(
      "one.zip \n Desc one",
      { modal: true },
      { title: "Install" },
    );
  });

  test("online install reports download errors from helper path", async () => {
    axios.get.mockResolvedValueOnce({ data: "#bad.zip\nDesc" });
    window.showQuickPick.mockResolvedValueOnce(["bad.zip"]);
    window.showInformationMessage.mockResolvedValueOnce({ title: "Install" });

    const runtime = {
      axiosRequest: jest.fn(async () => {
        throw new Error("network fail");
      }),
      createWriteStream: jest.fn(() => ({ on: jest.fn(), close: jest.fn() })),
      renameSync: jest.fn(),
      unlinkSync: jest.fn(),
      statSync: jest.fn(() => ({ size: 100 })),
      ensureDirSync: jest.fn(),
      existsSync: jest.fn(() => false),
      showErrorMessage: jest.fn(),
      openZipFile: jest.fn(async () => ({ files: [], extract: jest.fn() })),
      copyFileSync: jest.fn(),
      readdirSync: jest.fn(),
      getConfiguration: workspace.getConfiguration,
      showQuickPick: window.showQuickPick,
      showInformationMessage: window.showInformationMessage,
      axiosGet: axios.get,
    };

    await downloadAndInstallExtension({} as any, runtime as any);

    expect(runtime.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Download failed for https://ifarchive.org/contrib/bad.zip"));
    expect(client.error).toHaveBeenCalledWith(expect.stringContaining("Download failed for https://ifarchive.org/contrib/bad.zip"));
  });

  test("online install unzips .zip extension on successful download", async () => {
    axios.get.mockResolvedValueOnce({ data: "#good.zip\nDesc" });
    window.showQuickPick.mockResolvedValueOnce(["good.zip"]);
    window.showInformationMessage.mockResolvedValueOnce({ title: "Install" });

    const writerHandlers: Record<string, (...args: any[]) => void> = {};
    const writer = {
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        writerHandlers[event] = handler;
        return writer;
      }),
      close: jest.fn(),
      destroy: jest.fn(),
    };
    const readable = {
      pipe: jest.fn(() => {
        Promise.resolve().then(() => writerHandlers.close?.());
      }),
      on: jest.fn(() => readable),
    };

    const runtime = {
      axiosRequest: jest.fn(async () => ({ data: readable })),
      createWriteStream: jest.fn(() => writer),
      renameSync: jest.fn(),
      unlinkSync: jest.fn(),
      statSync: jest.fn(() => ({ size: 100 })),
      ensureDirSync: jest.fn(),
      existsSync: jest.fn(() => false),
      openZipFile: jest.fn(async () => ({ files: [], extract: jest.fn() })),
      copyFileSync: jest.fn(),
      readdirSync: jest.fn(),
      showErrorMessage: jest.fn(),
      getConfiguration: workspace.getConfiguration,
      showQuickPick: window.showQuickPick,
      showInformationMessage: window.showInformationMessage,
      axiosGet: axios.get,
    };

    await downloadAndInstallExtension({} as any, runtime as any);

    expect(runtime.openZipFile).toHaveBeenCalledWith("/project/good.zip");
    expect(client.info).toHaveBeenCalledWith("Unzipping good.zip to /project/good");
  });

  test("downloadAndCacheFile uses production runtime axiosRequest binding", async () => {
    const writerHandlers: Record<string, (...args: any[]) => void> = {};
    const writer = {
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        writerHandlers[event] = handler;
        return writer;
      }),
      close: jest.fn(),
      destroy: jest.fn(),
    };

    const { createWriteStream } = require("fs");
    createWriteStream.mockImplementationOnce(() => writer);
    existsSync.mockImplementation((targetPath: string) => targetPath !== "/cache/default.zip");

    axios.request.mockImplementationOnce(async (config: any) => {
      return {
        data: {
          pipe: () => {
            Promise.resolve().then(() => writerHandlers.close?.());
          },
        },
      };
    });

    await downloadAndCacheFile("https://ifarchive.org/default.zip", "/project", "default.zip", "/cache");

    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "get", url: "https://ifarchive.org/default.zip", responseType: "stream", maxRedirects: 0,
    }));
  });

  test("performLocalExtensionInstallation copies cached files and unzips zip archives", async () => {
    const runtime = {
      showQuickPick: jest.fn(async () => ["one.zip", "two.t"]),
      existsSync: jest.fn((targetPath: string) => targetPath === "/cache/one.zip" || targetPath === "/cache/two.t"),
      copyFileSync: jest.fn(),
      statSync: jest.fn(() => ({ size: 100 })),
      openZipFile: jest.fn(async () => ({ files: [], extract: jest.fn() })),
      ensureDirSync: jest.fn(),
    };
    const localState: any = {
      isUsingTads2: false,
      getChosenMakefileUri: jest.fn(() => ({ fsPath: "/project/Makefile.t3m" })),
      getTads2MainFile: jest.fn(() => ({ fsPath: "/project/main.t" })),
    };

    await performLocalExtensionInstallation("/cache", ["one.zip", "two.t"], localState, runtime as any);

    expect(runtime.copyFileSync).toHaveBeenCalledWith("/cache/one.zip", "/project/one.zip");
    expect(runtime.copyFileSync).toHaveBeenCalledWith("/cache/two.t", "/project/two.t");
    expect(runtime.openZipFile).toHaveBeenCalledWith("/project/one.zip");
    expect(runtime.openZipFile).not.toHaveBeenCalledWith("/project/two.t");
  });

  test("unzipFromFiletoFolder validates entries before extraction", async () => {
    const runtime = {
      statSync: jest.fn(() => ({ size: 100 })),
      existsSync: jest.fn(() => false),
      ensureDirSync: jest.fn(),
      mkdtempSync: jest.fn(() => "/tmp/out.partial-test"),
      mkdirSync: jest.fn(),
      createWriteStream: jest.fn(() => new Writable({ write(_chunk, _encoding, callback) { callback(); } })),
      renameSync: jest.fn(),
      rmSync: jest.fn(),
      openZipFile: jest.fn(async () => ({
        files: [{ path: "lib/source.t", type: "File", vars: { uncompressedSize: 50 }, stream: () => Readable.from(["source"]) }],
      })),
    };

    await unzipFromFiletoFolder("/tmp/sample.zip", "/tmp/out", runtime as any);

    expect(runtime.renameSync).toHaveBeenCalledWith("/tmp/out.partial-test", "/tmp/out");
    expect(runtime.createWriteStream).toHaveBeenCalledWith(
      "/tmp/out.partial-test/lib/source.t",
      { flags: "wx", mode: 0o600 },
    );
  });

  test("unzipFromFiletoFolder refuses an existing extraction destination", async () => {
    const runtime = {
      statSync: jest.fn(() => ({ size: 100 })),
      existsSync: jest.fn(() => true),
      openZipFile: jest.fn(async () => ({ files: [] })),
    };

    await expect(unzipFromFiletoFolder("/tmp/sample.zip", "/tmp/out", runtime as any)).rejects.toThrow(
      "Refusing to extract over an existing path",
    );
  });

  test("unzipFromFiletoFolder enforces expanded size while streaming", async () => {
    const megabyte = Buffer.alloc(1024 * 1024);
    const runtime = {
      statSync: jest.fn(() => ({ size: 100 })),
      existsSync: jest.fn(() => false),
      ensureDirSync: jest.fn(),
      mkdtempSync: jest.fn(() => "/tmp/out.partial-test"),
      mkdirSync: jest.fn(),
      createWriteStream: jest.fn(() => new Writable({ write(_chunk, _encoding, callback) { callback(); } })),
      renameSync: jest.fn(),
      rmSync: jest.fn(),
      openZipFile: jest.fn(async () => ({
        files: [{
          path: "large.t",
          type: "File",
          vars: { uncompressedSize: 1 },
          stream: () => Readable.from(Array.from({ length: 101 }, () => megabyte)),
        }],
      })),
    };

    await expect(unzipFromFiletoFolder("/tmp/large.zip", "/tmp/out", runtime as any)).rejects.toThrow(
      "Expanded archive exceeds",
    );
    expect(runtime.rmSync).toHaveBeenCalledWith("/tmp/out.partial-test", { recursive: true, force: true });
    expect(runtime.renameSync).not.toHaveBeenCalled();
  });

  test("unzipFromFiletoFolder rejects archive traversal entries", async () => {
    const failingRuntime = {
      statSync: jest.fn(() => ({ size: 100 })),
      ensureDirSync: jest.fn(),
      openZipFile: jest.fn(async () => ({
        files: [{ path: "../escape.t", vars: { uncompressedSize: 10 } }],
        extract: jest.fn(),
      })),
    };

    await expect(unzipFromFiletoFolder("/tmp/bad.zip", "/tmp/out", failingRuntime as any)).rejects.toThrow(
      "Unsafe path in archive",
    );

    expect(client.error).toHaveBeenCalledWith(expect.stringContaining("Setting up readstream for /tmp/bad.zip failed"));
  });

  test("unzipFromFiletoFolder rejects excessive expanded size", async () => {
    const runtime = {
      statSync: jest.fn(() => ({ size: 100 })),
      ensureDirSync: jest.fn(),
      openZipFile: jest.fn(async () => ({
        files: [{ path: "large.t", vars: { uncompressedSize: 101 * 1024 * 1024 } }],
        extract: jest.fn(),
      })),
    };

    await expect(unzipFromFiletoFolder("/tmp/large.zip", "/tmp/out", runtime as any)).rejects.toThrow(
      "Expanded archive exceeds",
    );
    expect(runtime.ensureDirSync).not.toHaveBeenCalled();
  });
	
});
