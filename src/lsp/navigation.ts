import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import * as fs from "fs";
import * as path from "path";
import { diagnoseFileAgainstCompileDb } from "../context/compileDb";

export type NavigationKind = "definition" | "declaration" | "implementation" | "references";

const shadowDocumentVersions = new Map<string, number>();

export async function requestNavigation(
  client: LanguageClient,
  kind: NavigationKind,
  document: vscode.TextDocument,
  position: vscode.Position,
  timeoutMs: number,
  logger?: (msg: string) => void
): Promise<vscode.Location[]> {
  const request = getRequestName(kind);
  const requestUri = resolveRequestUri(document, logger);
  await ensureShadowDocumentSynced(client, document, requestUri);
  logger?.(`[nav:${kind}] uri=${requestUri.toString()} shadow=${requestUri.toString() !== document.uri.toString()}`);
  const payload: any = {
    textDocument: { uri: requestUri.toString() },
    position: { line: position.line, character: position.character }
  };

  if (kind === "references") {
    payload.context = {
      includeDeclaration: true
    };
  }

  const result = await withTimeout(
    client.sendRequest<any>(request, payload),
    timeoutMs,
    `Navigation request timed out (${kind})`
  );

  const rawDesc = result === null ? "null"
    : result === undefined ? "undefined"
    : Array.isArray(result) ? `array(${result.length})`
    : "object";
  logger?.(`[nav:${kind}] raw=${rawDesc}`);

  return normalizeLocations(result, document.uri.fsPath);
}

async function ensureShadowDocumentSynced(
  client: LanguageClient,
  document: vscode.TextDocument,
  requestUri: vscode.Uri
): Promise<void> {
  if (requestUri.toString() === document.uri.toString()) {
    return;
  }

  const key = requestUri.toString();
  const previousVersion = shadowDocumentVersions.get(key);
  const text = document.getText();

  if (previousVersion === undefined) {
    client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: key,
        languageId: document.languageId,
        version: document.version,
        text
      }
    });
    shadowDocumentVersions.set(key, document.version);
    return;
  }

  if (previousVersion === document.version) {
    return;
  }

  client.sendNotification("textDocument/didChange", {
    textDocument: {
      uri: key,
      version: document.version
    },
    contentChanges: [{ text }]
  });
  shadowDocumentVersions.set(key, document.version);
}

function resolveRequestUri(document: vscode.TextDocument, logger?: (msg: string) => void): vscode.Uri {
  const diagnosis = diagnoseFileAgainstCompileDb(document.uri.fsPath);
  const { exactMatches, realpathMatches, suffixMatches, totalEntries, compileCommandsPath } = diagnosis;
  logger?.(
    `[nav] compileDb=${compileCommandsPath ?? "none"} entries=${totalEntries}` +
    ` exact=${exactMatches.length} realpath=${realpathMatches.length} suffix=${suffixMatches.length}`
  );
  const mappedPath = exactMatches[0] ?? realpathMatches[0] ?? suffixMatches[0];
  if (!mappedPath) {
    return document.uri;
  }

  if (normalizeFsPath(mappedPath) === normalizeFsPath(document.uri.fsPath)) {
    return document.uri;
  }

  return vscode.Uri.file(mappedPath);
}

function getRequestName(kind: NavigationKind): string {
  if (kind === "definition") {
    return "textDocument/definition";
  }
  if (kind === "declaration") {
    return "textDocument/declaration";
  }
  if (kind === "references") {
    return "textDocument/references";
  }
  return "textDocument/implementation";
}

function normalizeLocations(raw: any, originalDocumentPath?: string): vscode.Location[] {
  if (!raw) {
    return [];
  }

  const list = Array.isArray(raw) ? raw : [raw];
  const out: vscode.Location[] = [];

  for (const item of list) {
    if (!item || !item.uri || !item.range) {
      continue;
    }
    const start = new vscode.Position(item.range.start.line, item.range.start.character);
    const end = new vscode.Position(item.range.end.line, item.range.end.character);
    const mappedUri = remapLocationUri(vscode.Uri.parse(item.uri), originalDocumentPath);
    out.push(new vscode.Location(mappedUri, new vscode.Range(start, end)));
  }

  return out;
}

function remapLocationUri(uri: vscode.Uri, originalDocumentPath?: string): vscode.Uri {
  if (uri.scheme !== "file") {
    return uri;
  }

  if (originalDocumentPath && path.basename(uri.fsPath) === path.basename(originalDocumentPath)) {
    return vscode.Uri.file(originalDocumentPath);
  }

  const remapped = mapTmpWorkGitPathToWorkspace(uri.fsPath);
  if (remapped) {
    return vscode.Uri.file(remapped);
  }

  return uri;
}

function mapTmpWorkGitPathToWorkspace(filePath: string): string | undefined {
  const normalized = normalizeFsPath(filePath);
  const marker = "/tmp/work/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const rest = normalized.slice(markerIndex + marker.length);
  const segments = rest.split("/").filter(Boolean);
  if (segments.length < 5) {
    return undefined;
  }

  const packageName = segments[1];
  const gitIndex = segments.indexOf("git");
  if (gitIndex < 0 || gitIndex === segments.length - 1) {
    return undefined;
  }

  const relativePath = segments.slice(gitIndex + 1).join("/");
  const buildRoot = normalized.slice(0, markerIndex);
  const workspacePath = path.join(buildRoot, "workspace", "sources", packageName, relativePath);
  return fs.existsSync(workspacePath) ? workspacePath : undefined;
}

function normalizeFsPath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
