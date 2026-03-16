import * as vscode from "vscode";
import { ClangdManager } from "./clangd/manager";
import {
  diagnoseFileAgainstCompileDb,
  diagnoseFileAgainstSpecificCompileDb,
  listCompileDbCandidates,
  resolveCompileDb
} from "./context/compileDb";
import { requestNavigation, type NavigationKind } from "./lsp/navigation";
import { MetricsCollector } from "./metrics/collector";
import { openFirstOrPick } from "./ui/resultPicker";
import * as fs from "fs";
import * as path from "path";

const manager = new ClangdManager();
const metrics = new MetricsCollector();
const runtimeOutput = vscode.window.createOutputChannel("OpenBMC Jump Runtime");
const compileDbMatchCache = new Map<string, string>();
let manualCompileDbLock: string | undefined;
let autoSwitchPromise: Promise<void> | undefined;

type CompileDbPick = {
  label: string;
  description: string;
  uri?: vscode.Uri;
  action: "select" | "browse";
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(runtimeOutput);
  context.subscriptions.push(metrics);

  warmupClangdForCppEditors(context);

  registerJumpCommand(context, "openbmcJump.goToDefinition", "definition");
  registerJumpCommand(context, "openbmcJump.goToDeclaration", "declaration");
  registerJumpCommand(context, "openbmcJump.goToImplementation", "implementation");
  registerJumpCommand(context, "openbmcJump.findReferences", "references");
  registerLanguageProviders(context);

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.restartClangd", async () => {
      try {
        await manager.restart(context);
        vscode.window.showInformationMessage("OpenBMC Jump restarted clangd.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to restart clangd: ${msg}`);
      }
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.showMetrics", () => {
      metrics.show();
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.showActiveCompileDb", () => {
      const resolution = resolveCompileDb();
      if (resolution.compileCommandsPath) {
        runtimeOutput.appendLine(`[info] active compile_commands: ${resolution.compileCommandsPath}`);
        void vscode.window.showInformationMessage(`Active compile_commands: ${resolution.compileCommandsPath}`);
        return;
      }

      const message = resolution.issue ?? "No active compile_commands.json found.";
      runtimeOutput.appendLine(`[warn] ${message}`);
      void vscode.window.showWarningMessage(message);
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.selectCompileDb", async () => {
      const candidates = await vscode.workspace.findFiles(
        "**/compile_commands.json",
        "**/{.git,node_modules,dist,out}/**",
        200
      );

      const picks: CompileDbPick[] = candidates.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri, false),
        description: uri.fsPath,
        uri,
        action: "select" as const
      }));

      picks.unshift({
        label: "Browse for compile_commands.json...",
        description: "Select a compile database outside the current workspace",
        uri: undefined,
        action: "browse" as const
      });

      const selected = await vscode.window.showQuickPick(picks, {
        title: "Select compile_commands.json",
        placeHolder: "Choose the compile database to use for OpenBMC Jump"
      });

      if (!selected) {
        return;
      }

      let selectedUri = selected.uri;
      if (selected.action === "browse") {
        const opened = await vscode.window.showOpenDialog({
          title: "Select compile_commands.json",
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            JSON: ["json"]
          },
          openLabel: "Use compile_commands.json"
        });

        if (!opened || opened.length === 0) {
          return;
        }

        selectedUri = opened[0];
      }

      if (!selectedUri) {
        return;
      }

      if (!selectedUri.fsPath.endsWith("compile_commands.json")) {
        void vscode.window.showWarningMessage("Please select a file named compile_commands.json.");
        return;
      }

      await vscode.workspace
        .getConfiguration("openbmcJump")
        .update("compileCommands.path", selectedUri.fsPath, vscode.ConfigurationTarget.Workspace);

      manualCompileDbLock = selectedUri.fsPath;
      compileDbMatchCache.clear();

      runtimeOutput.appendLine(`[info] selected compile_commands: ${selectedUri.fsPath}`);
      runtimeOutput.appendLine(`[info] manual compile_commands lock enabled`);

      try {
        await manager.restart(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtimeOutput.appendLine(`[warn] restart after compile DB selection failed: ${msg}`);
      }

      void vscode.window.showInformationMessage(`OpenBMC Jump is now using: ${selectedUri.fsPath}`);
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.showClangdStatus", () => {
      const status = manager.getStatusSnapshot();
      const version = manager.getVersionSnapshot();
      const lines = [
        `clientState: ${status.clientState}`,
        `clangdPath: ${status.clangdPath}`,
        `clangdResolvedPath: ${version.resolvedPath ?? "<not found>"}`,
        `clangdVersion: ${version.versionLine ?? "<unknown>"}`,
        `compileCommandsPath: ${status.compileCommandsPath ?? "<not found>"}`,
        `compileCommandsIssue: ${status.compileCommandsIssue ?? "<none>"}`,
        `failureStreak: ${status.failureStreak}`,
        `inFailureCooldown: ${status.inFailureCooldown}`,
        `isRestartPending: ${status.isRestartPending}`
      ];

      for (const line of lines) {
        runtimeOutput.appendLine(`[status] ${line}`);
      }

      void vscode.window.showInformationMessage(
        `Clangd status: ${status.clientState}, version: ${version.versionLine ?? "unknown"}`
      );
      runtimeOutput.show(true);
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.showClangdVersion", () => {
      const snapshot = manager.getVersionSnapshot();
      const lines = [
        `source: ${snapshot.source}`,
        `configuredPath: ${snapshot.configuredPath ?? "<empty>"}`,
        `resolvedPath: ${snapshot.resolvedPath ?? "<not found>"}`,
        `version: ${snapshot.versionLine ?? "<unknown>"}`
      ];

      for (const line of lines) {
        runtimeOutput.appendLine(`[clangd-version] ${line}`);
      }

      const summary = snapshot.versionLine
        ? `clangd: ${snapshot.versionLine}`
        : `clangd path: ${snapshot.resolvedPath ?? "not found"}`;
      void vscode.window.showInformationMessage(summary);
      runtimeOutput.show(true);
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.diagnoseCurrentFile", () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || !isSupportedDocument(document)) {
        void vscode.window.showWarningMessage("Open a C/C++ file first.");
        return;
      }

      const diagnosis = diagnoseFileAgainstCompileDb(document.uri.fsPath);
      const lines = [
        `targetFile: ${diagnosis.targetFile}`,
        `compileCommandsPath: ${diagnosis.compileCommandsPath ?? "<not found>"}`,
        `issue: ${diagnosis.issue ?? "<none>"}`,
        `totalEntries: ${diagnosis.totalEntries}`,
        `exactMatches: ${diagnosis.exactMatches.length}`,
        `realpathMatches: ${diagnosis.realpathMatches.length}`,
        `suffixMatches: ${diagnosis.suffixMatches.length}`
      ];

      for (const line of lines) {
        runtimeOutput.appendLine(`[diagnose] ${line}`);
      }

      if (diagnosis.exactMatches.length > 0 || diagnosis.realpathMatches.length > 0) {
        void vscode.window.showInformationMessage("Current file is covered by the active compile_commands.json.");
      } else {
        void vscode.window.showWarningMessage(
          "Current file does not appear in the active compile_commands.json. Try selecting a different compile DB."
        );
      }

      runtimeOutput.show(true);
    }));

  context.subscriptions.push(vscode.commands.registerCommand("openbmcJump.analyzeCoreDump", async (uri?: vscode.Uri) => {
      await analyzeCoreDump(uri);
    }));
}

function warmupClangdForCppEditors(context: vscode.ExtensionContext): void {
  const maybeWarmup = (document: vscode.TextDocument | undefined): void => {
    if (!document || !isSupportedDocument(document)) {
      return;
    }

    void maybeAutoSwitchCompileDb(context, document).finally(() => {
      void manager.ensureClient(context, true).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        runtimeOutput.appendLine(`[warmup] skipped: ${msg}`);
      });
    });
  };

  maybeWarmup(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      maybeWarmup(editor?.document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      maybeWarmup(document);
    })
  );
}

function registerLanguageProviders(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" }
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (document, position) => {
        return safeProviderNavigation(context, "definition", document, position);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDeclarationProvider(selector, {
      provideDeclaration: async (document, position) => {
        return safeProviderNavigation(context, "declaration", document, position);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation: async (document, position) => {
        return safeProviderNavigation(context, "implementation", document, position);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences: async (document, position) => {
        return safeProviderNavigation(context, "references", document, position);
      }
    })
  );
}

async function safeProviderNavigation(
  context: vscode.ExtensionContext,
  kind: NavigationKind,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[]> {
  try {
    await maybeAutoSwitchCompileDb(context, document);
    return await performNavigation(context, kind, document, position, false, false, true, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtimeOutput.appendLine(`[provider] ${kind} failed: ${msg}`);
    if (isStartFailureCooldownError(err)) {
      return [];
    }
    return [];
  }
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && (document.languageId === "c" || document.languageId === "cpp");
}

function inferPackageName(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const workspaceSourcesMarker = "/workspace/sources/";
  const workspaceSourcesIndex = normalized.indexOf(workspaceSourcesMarker);
  if (workspaceSourcesIndex >= 0) {
    const rest = normalized.slice(workspaceSourcesIndex + workspaceSourcesMarker.length);
    const segments = rest.split("/").filter(Boolean);
    if (segments.length > 0) {
      return segments[0];
    }
  }

  const tmpWorkMarker = "/tmp/work/";
  const tmpWorkIndex = normalized.indexOf(tmpWorkMarker);
  if (tmpWorkIndex >= 0) {
    const rest = normalized.slice(tmpWorkIndex + tmpWorkMarker.length);
    const segments = rest.split("/").filter(Boolean);
    if (segments.length >= 3) {
      return segments[2];
    }
  }

  const fileName = path.basename(normalized);
  const parentDir = path.basename(path.dirname(normalized));
  return parentDir && parentDir !== fileName ? parentDir : undefined;
}

function isSamePackageCandidate(candidate: string, packageName: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.includes(`/workspace/sources/${packageName}/`)) {
    return true;
  }

  const tmpWorkMarker = "/tmp/work/";
  const tmpWorkIndex = normalized.indexOf(tmpWorkMarker);
  if (tmpWorkIndex < 0) {
    return false;
  }

  const rest = normalized.slice(tmpWorkIndex + tmpWorkMarker.length);
  const segments = rest.split("/").filter(Boolean);
  return segments.length >= 2 && segments[1] === packageName;
}

function inferBuildRoot(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const workspaceSourcesMarker = "/workspace/sources/";
  const workspaceSourcesIndex = normalized.indexOf(workspaceSourcesMarker);
  if (workspaceSourcesIndex >= 0) {
    return normalized.slice(0, workspaceSourcesIndex);
  }

  const tmpWorkMarker = "/tmp/work/";
  const tmpWorkIndex = normalized.indexOf(tmpWorkMarker);
  if (tmpWorkIndex >= 0) {
    return normalized.slice(0, tmpWorkIndex);
  }

  return undefined;
}

function inferPackageRoot(filePath: string, packageName: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const workspacePrefix = `/workspace/sources/${packageName}/`;
  const workspaceIndex = normalized.indexOf(workspacePrefix);
  if (workspaceIndex >= 0) {
    return normalized.slice(0, workspaceIndex + workspacePrefix.length - 1);
  }

  const tmpWorkPrefix = "/tmp/work/";
  const tmpWorkIndex = normalized.indexOf(tmpWorkPrefix);
  if (tmpWorkIndex >= 0) {
    const rest = normalized.slice(tmpWorkIndex + tmpWorkPrefix.length);
    const segments = rest.split("/").filter(Boolean);
    if (segments.length >= 3) {
      return normalized.slice(
        0,
        tmpWorkIndex + tmpWorkPrefix.length + segments.slice(0, 3).join("/").length
      );
    }
  }

  return undefined;
}

function searchCompileDbRecursively(rootDir: string, maxDepth: number): string | undefined {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return undefined;
  }

  const directCandidate = path.join(rootDir, "compile_commands.json");
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }

  if (maxDepth <= 0) {
    return undefined;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const match = searchCompileDbRecursively(path.join(rootDir, entry.name), maxDepth - 1);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function collectCompileDbRecursively(rootDir: string, maxDepth: number, out: Set<string>): void {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return;
  }

  const directCandidate = path.join(rootDir, "compile_commands.json");
  if (fs.existsSync(directCandidate)) {
    out.add(directCandidate);
  }

  if (maxDepth <= 0) {
    return;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    collectCompileDbRecursively(path.join(rootDir, entry.name), maxDepth - 1, out);
  }
}

function scoreCompileDbCandidate(targetFile: string, compileCommandsPath: string): number {
  const diagnosis = diagnoseFileAgainstSpecificCompileDb(targetFile, compileCommandsPath);
  if (diagnosis.exactMatches.length > 0) {
    return 1000;
  }
  if (diagnosis.realpathMatches.length > 0) {
    return 900;
  }
  if (diagnosis.suffixMatches.length > 0) {
    let score = 100;
    if (compileCommandsPath.includes("/workspace/sources/")) {
      score += 50;
    }
    if (compileCommandsPath.includes("/build/compile_commands.json")) {
      score -= 10;
    }
    return score;
  }
  return 0;
}

function chooseBestCompileDbCandidate(targetFile: string, candidates: Iterable<string>): string | undefined {
  let bestCandidate: string | undefined;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreCompileDbCandidate(targetFile, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestScore > 0 ? bestCandidate : undefined;
}

function findCompileDbFromCurrentPackage(filePath: string, packageName: string): string | undefined {
  const packageRoot = inferPackageRoot(filePath, packageName);
  if (!packageRoot) {
    return undefined;
  }

  const candidates = new Set<string>();
  collectCompileDbRecursively(packageRoot, 5, candidates);
  return chooseBestCompileDbCandidate(filePath, candidates);
}

function findCompileDbFromBuildTmpWork(filePath: string, packageName: string): string | undefined {
  const buildRoot = inferBuildRoot(filePath);
  if (!buildRoot) {
    return undefined;
  }

  const tmpWorkRoot = path.join(buildRoot, "tmp", "work");
  if (!fs.existsSync(tmpWorkRoot)) {
    return undefined;
  }

  let machineDirs: fs.Dirent[] = [];
  try {
    machineDirs = fs.readdirSync(tmpWorkRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const machineDir of machineDirs) {
    if (!machineDir.isDirectory()) {
      continue;
    }

    const recipeRoot = path.join(tmpWorkRoot, machineDir.name, packageName);
    if (!fs.existsSync(recipeRoot)) {
      continue;
    }

    const candidates = new Set<string>();
    collectCompileDbRecursively(recipeRoot, 6, candidates);
    const bestCandidate = chooseBestCompileDbCandidate(filePath, candidates);
    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return undefined;
}

async function maybeAutoSwitchCompileDb(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument
): Promise<void> {
  if (!isSupportedDocument(document)) {
    return;
  }

  const enabled = vscode.workspace
    .getConfiguration("openbmcJump")
    .get<boolean>("compileCommands.autoSwitchByFile", true);
  if (!enabled) {
    return;
  }

  const currentResolution = resolveCompileDb();
  if (manualCompileDbLock && currentResolution.compileCommandsPath === manualCompileDbLock) {
    return;
  }

  const directoryKey = path.dirname(document.uri.fsPath);
  const currentPath = currentResolution.compileCommandsPath;
  const cached = compileDbMatchCache.get(directoryKey);
  if (cached && cached === currentPath) {
    return;
  }

  if (autoSwitchPromise) {
    return autoSwitchPromise;
  }

  autoSwitchPromise = (async () => {
    const packageName = inferPackageName(document.uri.fsPath);
    if (packageName) {
      runtimeOutput.appendLine(`find package name : ${packageName}`);
      console.log(`find package name : ${packageName}`);
    }
    const currentDiagnosis = diagnoseFileAgainstCompileDb(document.uri.fsPath);
    if (currentDiagnosis.exactMatches.length > 0 || currentDiagnosis.realpathMatches.length > 0) {
      if (currentDiagnosis.compileCommandsPath) {
        compileDbMatchCache.set(directoryKey, currentDiagnosis.compileCommandsPath);
      }
      return;
    }

    if (packageName) {
      const nearbyCompileDb = findCompileDbFromCurrentPackage(document.uri.fsPath, packageName);
      if (nearbyCompileDb) {
        runtimeOutput.appendLine(`[auto-switch] package root compile_commands -> ${nearbyCompileDb}`);

        await vscode.workspace
          .getConfiguration("openbmcJump")
          .update("compileCommands.path", nearbyCompileDb, vscode.ConfigurationTarget.Workspace);

        compileDbMatchCache.set(directoryKey, nearbyCompileDb);

        try {
          await manager.restart(context);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          runtimeOutput.appendLine(`[auto-switch] restart failed: ${msg}`);
        }
        return;
      }

      const tmpWorkCompileDb = findCompileDbFromBuildTmpWork(document.uri.fsPath, packageName);
      if (tmpWorkCompileDb) {
        runtimeOutput.appendLine(`[auto-switch] tmp/work compile_commands -> ${tmpWorkCompileDb}`);

        await vscode.workspace
          .getConfiguration("openbmcJump")
          .update("compileCommands.path", tmpWorkCompileDb, vscode.ConfigurationTarget.Workspace);

        compileDbMatchCache.set(directoryKey, tmpWorkCompileDb);

        try {
          await manager.restart(context);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          runtimeOutput.appendLine(`[auto-switch] restart failed: ${msg}`);
        }
        return;
      }
    }

    const candidates = listCompileDbCandidates().filter((candidate) => candidate !== currentDiagnosis.compileCommandsPath);
    const orderedCandidates = packageName
      ? [
          ...candidates.filter((candidate) => isSamePackageCandidate(candidate, packageName)),
          ...candidates.filter((candidate) => !isSamePackageCandidate(candidate, packageName))
        ]
      : candidates;

    let packageFallbackCandidate: string | undefined;
    for (const candidate of orderedCandidates) {
      const diagnosis = diagnoseFileAgainstSpecificCompileDb(document.uri.fsPath, candidate);
      if (!packageFallbackCandidate && packageName && isSamePackageCandidate(candidate, packageName)) {
        packageFallbackCandidate = candidate;
      }
      if (diagnosis.exactMatches.length === 0 && diagnosis.realpathMatches.length === 0) {
        continue;
      }

      await vscode.workspace
        .getConfiguration("openbmcJump")
        .update("compileCommands.path", candidate, vscode.ConfigurationTarget.Workspace);

      compileDbMatchCache.set(directoryKey, candidate);
      runtimeOutput.appendLine(`[auto-switch] compile_commands -> ${candidate}`);

      try {
        await manager.restart(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtimeOutput.appendLine(`[auto-switch] restart failed: ${msg}`);
      }
      return;
    }

    if (packageFallbackCandidate && packageName) {
      await vscode.workspace
        .getConfiguration("openbmcJump")
        .update("compileCommands.path", packageFallbackCandidate, vscode.ConfigurationTarget.Workspace);

      compileDbMatchCache.set(directoryKey, packageFallbackCandidate);
      runtimeOutput.appendLine(`find package name : ${packageName}`);
      runtimeOutput.appendLine(`[auto-switch] compile_commands -> ${packageFallbackCandidate}`);
      console.log(`find package name : ${packageName}`);

      try {
        await manager.restart(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtimeOutput.appendLine(`[auto-switch] restart failed: ${msg}`);
      }
      return;
    }

    runtimeOutput.appendLine(`[auto-switch] no matching compile_commands for ${document.uri.fsPath}`);
  })().finally(() => {
    autoSwitchPromise = undefined;
  });

  return autoSwitchPromise;
}

function registerJumpCommand(
  context: vscode.ExtensionContext,
  commandId: string,
  kind: NavigationKind
): void {
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(commandId, async (editor) => {
      try {
        await maybeAutoSwitchCompileDb(context, editor.document);
        const locations = await performNavigation(
          context,
          kind,
          editor.document,
          editor.selection.active,
          true,
          true,
          true,
          true
        );

        if (locations.length === 0) {
          await handleZeroResult(kind);
          return;
        }

        if (kind === "references") {
          await vscode.commands.executeCommand(
            "editor.action.showReferences",
            editor.document.uri,
            editor.selection.active,
            locations
          );
          return;
        }

        await openFirstOrPick(locations);
      } catch (err) {
        if (isStartFailureCooldownError(err)) {
          vscode.window.showErrorMessage(
            "OpenBMC Jump failed to start clangd repeatedly. Check output panel (OpenBMC Jump) for details."
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Navigation failed: ${msg}`);
      }
    })
  );
}

async function performNavigation(
  context: vscode.ExtensionContext,
  kind: NavigationKind,
  document: vscode.TextDocument,
  position: vscode.Position,
  recordFailure: boolean,
  allowRestart: boolean,
  allowStart: boolean,
  interactive: boolean
): Promise<vscode.Location[]> {
  const timeoutMs = vscode.workspace.getConfiguration("openbmcJump").get<number>("requestTimeoutMs", 10000);

  const start = Date.now();
  try {
    let client = await manager.ensureClient(context, allowStart || allowRestart);
    let locations: vscode.Location[];

    try {
      locations = await requestNavigation(client, kind, document, position, timeoutMs, (msg) => runtimeOutput.appendLine(msg));
    } catch (err) {
      if (isNavigationTimeoutError(err)) {
        const retryTimeoutMs = Math.max(timeoutMs * 2, 15000);
        runtimeOutput.appendLine(
          `[nav] request timed out after ${timeoutMs}ms, retrying once with ${retryTimeoutMs}ms`
        );
        locations = await requestNavigation(client, kind, document, position, retryTimeoutMs, (msg) => runtimeOutput.appendLine(msg));
      } else {
      if (!allowRestart || !isClientNotRunningError(err)) {
        throw err;
      }
      client = await manager.restart(context);
      locations = await requestNavigation(client, kind, document, position, timeoutMs, (msg) => runtimeOutput.appendLine(msg));
      }
    }

    metrics.record({
      operation: kind,
      elapsedMs: Date.now() - start,
      resultCount: locations.length,
      success: true
    });

    if (locations.length === 0) {
      logZeroResult(kind, document, position);
      if (interactive) {
        runtimeOutput.show(true);
      }
    }

    return locations;
  } catch (err) {
    if (recordFailure) {
      metrics.record({
        operation: kind,
        elapsedMs: Date.now() - start,
        resultCount: 0,
        success: false
      });
    }
    throw err;
  }
}

function logZeroResult(
  kind: NavigationKind,
  document: vscode.TextDocument,
  position: vscode.Position
): void {
  const wordRange = document.getWordRangeAtPosition(position);
  const symbol = wordRange ? document.getText(wordRange) : "<unknown>";
  const resolution = resolveCompileDb();
  runtimeOutput.appendLine(
    `[no-result] op=${kind} symbol=${symbol} file=${document.uri.fsPath} line=${position.line + 1} compileDb=${resolution.compileCommandsPath ?? "<not found>"}`
  );
  if (resolution.issue) {
    runtimeOutput.appendLine(`[no-result] issue=${resolution.issue}`);
  }
}

async function handleZeroResult(kind: NavigationKind): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    `OpenBMC Jump did not find a ${kind} target. Check compile_commands selection or clangd status.`,
    "Show Active Compile DB",
    "Select Compile DB",
    "Show Clangd Status"
  );

  if (action === "Show Active Compile DB") {
    await vscode.commands.executeCommand("openbmcJump.showActiveCompileDb");
    return;
  }

  if (action === "Select Compile DB") {
    await vscode.commands.executeCommand("openbmcJump.selectCompileDb");
    return;
  }

  if (action === "Show Clangd Status") {
    await vscode.commands.executeCommand("openbmcJump.showClangdStatus");
  }
}

function isClientNotRunningError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /client is not running|can't be stopped|startfailed|connection got disposed|pending response rejected/i.test(message);
}

function isStartFailureCooldownError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /start failed repeatedly/i.test(message);
}

function isNavigationTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Navigation request timed out/i.test(message);
}

export async function deactivate(): Promise<void> {
  metrics.dispose();
  await manager.stop();
}

async function analyzeCoreDump(inputUri?: vscode.Uri): Promise<void> {
  const coreUri = inputUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!coreUri || coreUri.scheme !== "file") {
    vscode.window.showErrorMessage("Please select a core dump file first.");
    return;
  }

  const executable = await vscode.window.showOpenDialog({
    title: "Select executable for this core dump",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Use Executable"
  });

  if (!executable || executable.length === 0) {
    return;
  }

  const terminal = vscode.window.createTerminal("OpenBMC Jump Core Dump");
  const exePath = executable[0].fsPath.replace(/"/g, '\\"');
  const corePath = coreUri.fsPath.replace(/"/g, '\\"');
  terminal.show(true);
  terminal.sendText(`gdb -q \"${exePath}\" \"${corePath}\"`);
}
