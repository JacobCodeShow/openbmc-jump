import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface CompileDbResolution {
  compileCommandsPath?: string;
  workingDirectory?: string;
  issue?: string;
}

interface CompileCommandEntry {
  directory?: string;
  file?: string;
  command?: string;
  arguments?: string[];
}

export interface CompileDbFileDiagnosis {
  compileCommandsPath?: string;
  issue?: string;
  targetFile: string;
  exactMatches: string[];
  realpathMatches: string[];
  suffixMatches: string[];
  totalEntries: number;
}

const COMMON_LOCATIONS = ["compile_commands.json", "build/compile_commands.json"];
const DEFAULT_SEARCH_ROOTS = ["build", "tmp"];

export function resolveCompileDb(): CompileDbResolution {
  const config = vscode.workspace.getConfiguration("openbmcJump");
  const customPath = config.get<string>("compileCommands.path", "").trim();
  const configuredRoots = config.get<string[]>("compileCommands.searchRoots", DEFAULT_SEARCH_ROOTS);
  const maxDepth = config.get<number>("compileCommands.maxSearchDepth", 6);

  if (customPath) {
    const abs = path.isAbsolute(customPath)
      ? customPath
      : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", customPath);
    if (fs.existsSync(abs)) {
      return { compileCommandsPath: abs, workingDirectory: path.dirname(abs) };
    }
    return { issue: `Configured compile_commands file does not exist: ${abs}` };
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const rel of COMMON_LOCATIONS) {
      const candidate = path.join(folder.uri.fsPath, rel);
      if (fs.existsSync(candidate)) {
        return { compileCommandsPath: candidate, workingDirectory: path.dirname(candidate) };
      }
    }

    const recursiveMatch = findCompileDbRecursively(folder.uri.fsPath, configuredRoots, maxDepth);
    if (recursiveMatch) {
      return { compileCommandsPath: recursiveMatch, workingDirectory: path.dirname(recursiveMatch) };
    }
  }

  return {
    issue:
      "No compile_commands.json detected. Navigation may be imprecise. Configure openbmcJump.compileCommands.path if needed."
  };
}

export function diagnoseFileAgainstCompileDb(targetFile: string): CompileDbFileDiagnosis {
  const resolution = resolveCompileDb();
  if (!resolution.compileCommandsPath) {
    return {
      targetFile,
      exactMatches: [],
      realpathMatches: [],
      suffixMatches: [],
      totalEntries: 0,
      issue: resolution.issue,
      compileCommandsPath: resolution.compileCommandsPath
    };
  }

  return diagnoseFileAgainstSpecificCompileDb(targetFile, resolution.compileCommandsPath);
}

export function diagnoseFileAgainstSpecificCompileDb(
  targetFile: string,
  compileCommandsPath: string
): CompileDbFileDiagnosis {
  const entries = readCompileCommands(compileCommandsPath);
  const targetRealpath = safeRealpath(targetFile);
  const normalizedTarget = normalizePath(targetFile);

  const exactMatches = new Set<string>();
  const realpathMatches = new Set<string>();
  const suffixMatches = new Set<string>();

  for (const entry of entries) {
    const entryFile = resolveEntryFile(entry);
    if (!entryFile) {
      continue;
    }

    const normalizedEntry = normalizePath(entryFile);
    if (normalizedEntry === normalizedTarget) {
      exactMatches.add(entryFile);
    }

    const entryRealpath = safeRealpath(entryFile);
    if (targetRealpath && entryRealpath && entryRealpath === targetRealpath) {
      realpathMatches.add(entryFile);
    }

    if (
      normalizedEntry.endsWith(`/${path.basename(normalizedTarget)}`) ||
      normalizedTarget.endsWith(`/${path.basename(normalizedEntry)}`)
    ) {
      suffixMatches.add(entryFile);
    }
  }

  return {
    compileCommandsPath,
    targetFile,
    exactMatches: [...exactMatches],
    realpathMatches: [...realpathMatches],
    suffixMatches: [...suffixMatches].slice(0, 20),
    totalEntries: entries.length
  };
}

export function listCompileDbCandidates(): string[] {
  const config = vscode.workspace.getConfiguration("openbmcJump");
  const configuredRoots = config.get<string[]>("compileCommands.searchRoots", DEFAULT_SEARCH_ROOTS);
  const externalRoots = config.get<string[]>("compileCommands.externalSearchRoots", []);
  const maxDepth = config.get<number>("compileCommands.maxSearchDepth", 6);
  const resolution = resolveCompileDb();

  const candidates = new Set<string>();
  if (resolution.compileCommandsPath) {
    candidates.add(resolution.compileCommandsPath);
    for (const inferred of inferSearchRootsFromCompileDb(resolution.compileCommandsPath)) {
      collectCompileDbFromRoot(inferred, maxDepth, candidates);
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    collectCompileDbFromRoot(folder.uri.fsPath, 2, candidates);

    for (const relRoot of [...configuredRoots, ...externalRoots]) {
      const absRoot = path.isAbsolute(relRoot) ? relRoot : path.join(folder.uri.fsPath, relRoot);
      collectCompileDbFromRoot(absRoot, maxDepth, candidates);
    }
  }

  return [...candidates];
}

function findCompileDbRecursively(
  workspaceRoot: string,
  configuredRoots: string[],
  maxDepth: number
): string | undefined {
  const roots = Array.from(new Set([...(configuredRoots ?? []), ...DEFAULT_SEARCH_ROOTS]))
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const relRoot of roots) {
    const absRoot = path.isAbsolute(relRoot) ? relRoot : path.join(workspaceRoot, relRoot);
    if (!fs.existsSync(absRoot)) {
      continue;
    }

    const match = searchDirectory(absRoot, 0, Math.max(1, maxDepth));
    if (match) {
      return match;
    }
  }

  return undefined;
}

function collectCompileDbFromRoot(rootDir: string, maxDepth: number, out: Set<string>): void {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return;
  }

  const directCandidate = path.join(rootDir, "compile_commands.json");
  if (fs.existsSync(directCandidate)) {
    out.add(directCandidate);
  }

  const match = searchDirectory(rootDir, 0, Math.max(1, maxDepth), out);
  if (match) {
    out.add(match);
  }
}

function inferSearchRootsFromCompileDb(compileCommandsPath: string): string[] {
  const normalized = normalizePath(compileCommandsPath);
  const markers = ["/workspace/sources/", "/tmp/work/"];
  const out = new Set<string>();

  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      out.add(normalized.slice(0, index + marker.length - 1));
    }
  }

  out.add(path.dirname(compileCommandsPath));
  return [...out];
}

function readCompileCommands(compileCommandsPath: string): CompileCommandEntry[] {
  try {
    const raw = fs.readFileSync(compileCommandsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveEntryFile(entry: CompileCommandEntry): string | undefined {
  if (!entry.file) {
    return undefined;
  }

  if (path.isAbsolute(entry.file)) {
    return entry.file;
  }

  if (!entry.directory) {
    return undefined;
  }

  return path.join(entry.directory, entry.file);
}

function normalizePath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/");
}

function safeRealpath(filePath: string): string | undefined {
  try {
    return normalizePath(fs.realpathSync.native(filePath));
  } catch {
    return undefined;
  }
}

function searchDirectory(
  currentDir: string,
  currentDepth: number,
  maxDepth: number,
  collector?: Set<string>
): string | undefined {
  const candidate = path.join(currentDir, "compile_commands.json");
  if (fs.existsSync(candidate)) {
    collector?.add(candidate);
    return candidate;
  }

  if (currentDepth >= maxDepth) {
    return undefined;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
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

    const match = searchDirectory(path.join(currentDir, entry.name), currentDepth + 1, maxDepth, collector);
    if (match) {
      return match;
    }
  }

  return undefined;
}
