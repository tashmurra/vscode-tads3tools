import { describe, expect, jest, test } from "@jest/globals";
import { workspace } from "vscode";
import { expandWorkspaceFolder } from "../modules/workspace-path";

describe("expandWorkspaceFolder", () => {
  test("expands the workspace folder variable", () => {
    (workspace as any).workspaceFolders = [{ uri: { fsPath: "/path/to/project" } }];

    expect(expandWorkspaceFolder("${workspaceFolder}/tools/t3make")).toBe("/path/to/project/tools/t3make");
  });

  test("leaves the value unchanged when no workspace folder is open", () => {
    (workspace as any).workspaceFolders = undefined;

    expect(expandWorkspaceFolder("${workspaceFolder}/tools/t3make")).toBe("${workspaceFolder}/tools/t3make");
  });
});
