import { workspace } from "vscode";

const workspaceFolderVariable = /\$\{workspaceFolder\}/g;

export function expandWorkspaceFolder(value: string): string {
  const workspaceFolder = workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return value;
  }

  return value.replace(workspaceFolderVariable, workspaceFolder.uri.fsPath);
}
