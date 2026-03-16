import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State
} from "vscode-languageclient/node";
import { ExecuteCommandRequest } from "vscode-languageserver-protocol";
import { resolveCompileDb } from "../context/compileDb";

class ClangdCommandMapper {
  private readonly originalToProxy = new Map<string, string>();
  private readonly refCounts = new Map<string, number>();
  private readonly registrations = new Map<string, vscode.Disposable>();
  private nextId = 0;

  public acquire(client: LanguageClient, command: string): vscode.Disposable {
    const proxyCommand = this.getOrCreateProxyCommand(command);
    const refCount = this.refCounts.get(proxyCommand) ?? 0;

    if (refCount === 0) {
      const executeOriginal = (_command: string, args: unknown[]) => {
        const params = { command, arguments: args };
        return client.sendRequest(ExecuteCommandRequest.type, params).then(
          undefined,
          (error) => client.handleFailedRequest(ExecuteCommandRequest.type, undefined, error, undefined)
        );
      };

      const disposable = vscode.commands.registerCommand(proxyCommand, (...args: unknown[]) => {
        const middleware = client.middleware;
        return middleware.executeCommand
          ? middleware.executeCommand(command, args, executeOriginal)
          : executeOriginal(command, args);
      });

      this.registrations.set(proxyCommand, disposable);
    }

    this.refCounts.set(proxyCommand, refCount + 1);
    return new vscode.Disposable(() => this.release(proxyCommand));
  }

  public rewriteCommand<T extends vscode.Command | undefined>(command: T): T {
    if (!command) {
      return command;
    }

    const proxyCommand = this.originalToProxy.get(command.command);
    if (!proxyCommand) {
      return command;
    }

    return { ...command, command: proxyCommand } as T;
  }

  public rewriteCodeActionResult(
    items: Array<vscode.Command | vscode.CodeAction> | null | undefined
  ): Array<vscode.Command | vscode.CodeAction> | null | undefined {
    if (!items) {
      return items;
    }

    return items.map((item) => {
      if (item instanceof vscode.CodeAction) {
        item.command = this.rewriteCommand(item.command);
        return item;
      }

      return this.rewriteCommand(item) ?? item;
    });
  }

  public rewriteCodeAction(item: vscode.CodeAction): vscode.CodeAction {
    item.command = this.rewriteCommand(item.command);
    return item;
  }

  public rewriteCodeLens(items: vscode.CodeLens[] | null | undefined): vscode.CodeLens[] | null | undefined {
    if (!items) {
      return items;
    }

    for (const item of items) {
      item.command = this.rewriteCommand(item.command);
    }
    return items;
  }

  public rewriteSingleCodeLens(item: vscode.CodeLens): vscode.CodeLens {
    item.command = this.rewriteCommand(item.command);
    return item;
  }

  public rewriteInlayHints(items: vscode.InlayHint[] | null | undefined): vscode.InlayHint[] | null | undefined {
    if (!items) {
      return items;
    }

    for (const item of items) {
      if (Array.isArray(item.label)) {
        for (const part of item.label) {
          part.command = this.rewriteCommand(part.command);
        }
      }
    }

    return items;
  }

  public rewriteInlineCompletionItems(
    items: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined
  ): vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined {
    if (!items) {
      return items;
    }

    if (Array.isArray(items)) {
      for (const item of items) {
        item.command = this.rewriteCommand(item.command);
      }
      return items;
    }

    for (const item of items.items) {
      item.command = this.rewriteCommand(item.command);
    }
    return items;
  }

  private getOrCreateProxyCommand(command: string): string {
    const existing = this.originalToProxy.get(command);
    if (existing) {
      return existing;
    }

    this.nextId += 1;
    const proxyCommand = `openbmcJump.clangdCommand.${this.nextId}`;
    this.originalToProxy.set(command, proxyCommand);
    return proxyCommand;
  }

  private release(proxyCommand: string): void {
    const refCount = this.refCounts.get(proxyCommand);
    if (!refCount) {
      return;
    }

    if (refCount > 1) {
      this.refCounts.set(proxyCommand, refCount - 1);
      return;
    }

    this.refCounts.delete(proxyCommand);
    this.registrations.get(proxyCommand)?.dispose();
    this.registrations.delete(proxyCommand);
  }
}

class NamespacedExecuteCommandFeature {
  private readonly commands = new Map<string, vscode.Disposable[]>();

  constructor(
    private readonly client: LanguageClient,
    private readonly commandMapper: ClangdCommandMapper
  ) {}

  public getState(): { kind: string; id: string; registrations: boolean } {
    return { kind: "workspace", id: this.registrationType.method, registrations: this.commands.size > 0 };
  }

  public get registrationType(): { method: string } {
    return { method: "workspace/executeCommand" };
  }

  public fillClientCapabilities(capabilities: Record<string, unknown>): void {
    const workspace = (capabilities.workspace ??= {}) as Record<string, unknown>;
    const executeCommand = (workspace.executeCommand ??= {}) as Record<string, unknown>;
    executeCommand.dynamicRegistration = true;
  }

  public initialize(capabilities: { executeCommandProvider?: { commands?: string[] } }): void {
    if (!capabilities.executeCommandProvider) {
      return;
    }

    this.register({
      id: `openbmcJump-execute-command-${Date.now()}`,
      registerOptions: { ...capabilities.executeCommandProvider }
    });
  }

  public register(data: { id: string; registerOptions: { commands?: string[] } }): void {
    if (!data.registerOptions.commands) {
      return;
    }

    const disposables = data.registerOptions.commands.map((command) => this.commandMapper.acquire(this.client, command));
    this.commands.set(data.id, disposables);
  }

  public unregister(id: string): void {
    const disposables = this.commands.get(id);
    if (!disposables) {
      return;
    }

    for (const disposable of disposables) {
      disposable.dispose();
    }
    this.commands.delete(id);
  }

  public clear(): void {
    for (const disposables of this.commands.values()) {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }
    this.commands.clear();
  }
}

function installNamespacedExecuteCommandFeature(client: LanguageClient, commandMapper: ClangdCommandMapper): void {
  const featureBag = client as unknown as {
    _features: Array<{ registrationType?: { method?: string } }>;
  };

  featureBag._features = featureBag._features.filter(
    (feature) => feature.registrationType?.method !== "workspace/executeCommand"
  );
  featureBag._features.push(new NamespacedExecuteCommandFeature(client, commandMapper));
}

export interface ClangdStatusSnapshot {
  clientState: string;
  compileCommandsPath?: string;
  compileCommandsIssue?: string;
  clangdPath: string;
  failureStreak: number;
  inFailureCooldown: boolean;
  isRestartPending: boolean;
}

export interface ClangdVersionSnapshot {
  configuredPath?: string;
  resolvedPath?: string;
  source: "configuration" | "path" | "missing";
  versionLine?: string;
}

interface ClangdBinaryValidationResult {
  executable?: string;
  versionLine?: string;
  error?: string;
}

function isDebugLoggingEnabled(): boolean {
  return vscode.workspace.getConfiguration("openbmcJump").get<boolean>("debugLogging", false);
}

class ClangdOutputChannel implements vscode.OutputChannel {
  public readonly name: string;
  private pendingLine = "";
  private didReportFormatCompatibilityIssue = false;
  private static readonly FORMAT_COMPATIBILITY_PATTERN =
    /\.clang-format|clang-format|unexpected scalar|invalid boolean|AlignTrailingComments/i;

  constructor(private readonly channel: vscode.OutputChannel) {
    this.name = channel.name;
  }

  public append(value: string): void {
    this.processChunk(value, false);
  }

  public appendLine(value: string): void {
    this.processChunk(value, true);
  }

  public replace(value: string): void {
    this.pendingLine = "";
    this.didReportFormatCompatibilityIssue = false;
    this.channel.replace(value);
  }

  public clear(): void {
    this.pendingLine = "";
    this.channel.clear();
  }

  public show(preserveFocus?: boolean): void;
  public show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  public show(first?: boolean | vscode.ViewColumn, second?: boolean): void {
    if (typeof first === "boolean" || typeof first === "undefined") {
      this.channel.show(first);
      return;
    }

    this.channel.show(first, second);
  }

  public hide(): void {
    this.channel.hide();
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private processChunk(value: string, forceNewLine: boolean): void {
    const merged = `${this.pendingLine}${value}${forceNewLine ? "\n" : ""}`;
    const lines = merged.split(/\r?\n/);
    this.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      this.writeLine(line);
    }
  }

  private writeLine(line: string): void {
    if (!this.shouldWriteLine(line)) {
      return;
    }

    if (!ClangdOutputChannel.FORMAT_COMPATIBILITY_PATTERN.test(line)) {
      this.channel.appendLine(line);
      return;
    }

    if (this.didReportFormatCompatibilityIssue) {
      return;
    }

    this.didReportFormatCompatibilityIssue = true;
    this.channel.appendLine(line);
    const clangdLocation = describeCurrentClangdLocation();
    this.channel.appendLine(
      `[warn] detected clangd/.clang-format compatibility issue. Current clangd: ${clangdLocation}. Recommend using clangd 17 or newer via openbmcJump.clangd.path. After installation or configuration is complete, restart clangd.`
    );
    void vscode.window.showWarningMessage(
      `检测到 clangd 与项目 .clang-format 版本不兼容。当前 clangd: ${clangdLocation}。建议使用 clangd 17 或更高版本；安装或配置完成后，请重启 clangd。`
    );
  }

  private shouldWriteLine(line: string): boolean {
    if (/^\[(warn|error)\]/.test(line)) {
      return true;
    }

    if (/^\[(info|state)\]/.test(line)) {
      return isDebugLoggingEnabled();
    }

    if (/^[IV]\[/.test(line)) {
      return isDebugLoggingEnabled();
    }

    return true;
  }
}

function describeCurrentClangdLocation(): string {
  const snapshot = getCurrentClangdSnapshot();
  return snapshot.configuredPath ?? snapshot.resolvedPath ?? "not found in PATH";
}

function findExecutableOnPath(name: string): string | undefined {
  const envPath = process.env.PATH;
  if (!envPath) {
    return undefined;
  }

  for (const entry of envPath.split(":")) {
    if (!entry) {
      continue;
    }

    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function getCurrentClangdSnapshot(): ClangdVersionSnapshot {
  const configuredPath = vscode.workspace.getConfiguration("openbmcJump").get<string>("clangd.path", "").trim();
  if (configuredPath) {
    return {
      configuredPath,
      resolvedPath: configuredPath,
      source: "configuration"
    };
  }

  const resolvedPath = findExecutableOnPath("clangd");
  if (resolvedPath) {
    return {
      resolvedPath,
      source: "path"
    };
  }

  return {
    source: "missing"
  };
}

function validateClangdBinary(clangdPath: string): ClangdBinaryValidationResult {
  let executable = clangdPath;
  if (clangdPath === "clangd") {
    executable = findExecutableOnPath("clangd") ?? clangdPath;
  }

  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });

  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  const firstLine = stdout?.split(/\r?\n/, 1)[0] ?? stderr?.split(/\r?\n/, 1)[0];

  if (result.error) {
    return {
      executable,
      versionLine: firstLine,
      error: `failed to execute clangd binary: ${result.error.message}`
    };
  }

  if (result.status !== 0 || !firstLine) {
    return {
      executable,
      versionLine: firstLine,
      error: `failed to read clangd version from: ${executable}`
    };
  }

  if (!/^clangd version\b/i.test(firstLine)) {
    return {
      executable,
      versionLine: firstLine,
      error: `configured binary is not clangd: ${executable} (${firstLine})`
    };
  }

  return {
    executable,
    versionLine: firstLine
  };
}

function buildServerEnvPath(clangdPath: string, extraPaths: string[]): string | undefined {
  const pathEntries: string[] = [];

  if (path.isAbsolute(clangdPath)) {
    pathEntries.push(path.dirname(clangdPath));
  }

  pathEntries.push(...extraPaths);

  const currentPath = process.env.PATH ?? "";
  pathEntries.push(...currentPath.split(":").filter(Boolean));

  const uniqueEntries = Array.from(new Set(pathEntries.filter(Boolean)));
  return uniqueEntries.length > 0 ? uniqueEntries.join(":") : undefined;
}

export class ClangdManager {
  private client: LanguageClient | undefined;
  private readonly output = new ClangdOutputChannel(vscode.window.createOutputChannel("OpenBMC Jump"));
  private readonly commandMapper = new ClangdCommandMapper();
  private isStopping = false;
  private isRestarting = false;
  private restartPending = false;
  private context: vscode.ExtensionContext | undefined;
  private startPromise: Promise<LanguageClient> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartPromise: Promise<LanguageClient> | undefined;
  private lastStartFailedAt = 0;
  private failureStreak = 0;
  private static readonly START_FAILURE_COOLDOWN_MS = 15000;
  private static readonly MAX_FAILURE_STREAK = 1;

  public async start(context: vscode.ExtensionContext): Promise<LanguageClient> {
    this.context = context;
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.client) {
      if (this.client.state === State.Running || this.client.state === State.Starting) {
        return this.client;
      }
      this.output.appendLine("[warn] discard stale clangd client before start");
      this.client = undefined;
    }

    const clangdPath = this.resolveClangdPath();
    if (!fs.existsSync(clangdPath) && clangdPath !== "clangd") {
      throw new Error(`clangd binary not found: ${clangdPath}`);
    }

    const binaryValidation = validateClangdBinary(clangdPath);
    if (binaryValidation.error) {
      throw new Error(`${binaryValidation.error}. Please configure openbmcJump.clangd.path to a clangd executable. Recommend using clangd 17 or newer, for example: ~/.install/clang+llvm-17.0.6-x86_64-linux-gnu-ubuntu-22.04/bin/clangd. After installation or configuration is complete, restart clangd.`);
    }

    const compileDb = resolveCompileDb();
    if (compileDb.issue) {
      this.output.appendLine(`[warn] ${compileDb.issue}`);
      vscode.window.showWarningMessage(compileDb.issue);
    } else if (compileDb.compileCommandsPath) {
      this.output.appendLine(`[info] compile_commands: ${compileDb.compileCommandsPath}`);
    }

    const args = ["--header-insertion=never", "--background-index"];
    if (compileDb.workingDirectory) {
      args.push(`--compile-commands-dir=${compileDb.workingDirectory}`);
    }

    // Auto-detect cross-compiler for --query-driver
    const extraEnv: Record<string, string> = {};
    const extraPaths: string[] = [];
    const manualQueryDriver = vscode.workspace
      .getConfiguration("openbmcJump")
      .get<string>("clangd.queryDriver", "")
      .trim();
    if (manualQueryDriver) {
      args.push(`--query-driver=${manualQueryDriver}`);
    } else if (compileDb.workingDirectory) {
      const crossInfo = inferCrossCompilerInfo(compileDb.workingDirectory, this.output);
      if (crossInfo) {
        args.push(`--query-driver=${crossInfo.compilerGlob}`);
        if (crossInfo.extraPaths.length > 0) {
          extraPaths.push(...crossInfo.extraPaths);
        }
      }
    }

    const serverEnvPath = buildServerEnvPath(clangdPath, extraPaths);
    if (serverEnvPath) {
      extraEnv.PATH = serverEnvPath;
    }

    const serverOptions: ServerOptions = {
      command: clangdPath,
      args,
      options: {
        env: { ...process.env, ...extraEnv }
      }
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { language: "c", scheme: "file" },
        { language: "cpp", scheme: "file" }
      ],
      outputChannel: this.output,
      initializationOptions: {},
      middleware: {
        provideCodeActions: async (document, range, context, token, next) => {
          const items = await next(document, range, context, token);
          return this.commandMapper.rewriteCodeActionResult(items ?? undefined) ?? null;
        },
        resolveCodeAction: async (item, token, next) => {
          const resolved = await next(item, token);
          return resolved ? this.commandMapper.rewriteCodeAction(resolved) : item;
        },
        provideCodeLenses: async (document, token, next) => {
          const items = await next(document, token);
          return this.commandMapper.rewriteCodeLens(items ?? undefined) ?? null;
        },
        resolveCodeLens: async (item, token, next) => {
          const resolved = await next(item, token);
          return resolved ? this.commandMapper.rewriteSingleCodeLens(resolved) : item;
        },
        provideInlayHints: async (document, viewPort, token, next) => {
          const items = await next(document, viewPort, token);
          return this.commandMapper.rewriteInlayHints(items ?? undefined) ?? null;
        },
        resolveInlayHint: async (item, token, next) => {
          const resolved = await next(item, token);
          if (!resolved) {
            return item;
          }
          return this.commandMapper.rewriteInlayHints([resolved])?.[0] ?? item;
        },
        provideInlineCompletionItems: async (document, position, context, token, next) => {
          const items = await next(document, position, context, token);
          return this.commandMapper.rewriteInlineCompletionItems(items ?? undefined) ?? null;
        }
      },
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        closed: () => ({ action: CloseAction.DoNotRestart })
      }
    };

    this.output.appendLine(`[info] starting clangd: ${clangdPath} ${args.join(" ")}`);

    this.client = new LanguageClient("openbmcJumpClangd", "OpenBMC Jump clangd", serverOptions, clientOptions);
    installNamespacedExecuteCommandFeature(this.client, this.commandMapper);
    const activeClient = this.client;
    this.client.onDidChangeState((event) => {
      if (this.client !== activeClient) {
        return;
      }
      this.output.appendLine(`[state] ${State[event.oldState]} -> ${State[event.newState]}`);
      if (event.newState === State.Running) {
        this.failureStreak = 0;
        this.output.appendLine("[info] clangd is ready");
      }
      if (event.newState === State.Stopped) {
        void this.handleUnexpectedStop();
      }
    });

    context.subscriptions.push(this.client);
    this.startPromise = (async () => {
      try {
        await this.client!.start();
        return this.client!;
      } catch (err) {
        this.lastStartFailedAt = Date.now();
        this.failureStreak += 1;
        this.output.appendLine(`[error] clangd start failed: ${err instanceof Error ? err.message : String(err)}`);
        this.client = undefined;
        throw err;
      } finally {
        this.startPromise = undefined;
      }
    })();

    return this.startPromise;
  }

  public async restart(context: vscode.ExtensionContext): Promise<LanguageClient> {
    if (this.restartPromise) {
      return this.restartPromise;
    }

    this.clearRestartTimer();
    this.restartPromise = (async () => {
      this.isRestarting = true;
      this.isStopping = true;
      try {
        const oldClient = this.client;
        this.client = undefined;
        this.startPromise = undefined;

        if (oldClient) {
          try {
            // vscode-languageclient 在 starting/startFailed 状态 stop 会抛错，直接丢弃旧实例并重建。
            if (oldClient.state === State.Running) {
              await oldClient.stop();
            } else {
              this.output.appendLine(
                `[warn] skip stop for clangd state=${State[oldClient.state]}, recreate client directly`
              );
            }
          } catch (err) {
            this.output.appendLine(
              `[warn] ignore clangd stop error during restart: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return this.start(context);
      } finally {
        this.isStopping = false;
        this.isRestarting = false;
        this.restartPromise = undefined;
      }
    })();

    return this.restartPromise;
  }

  public async ensureClient(
    context: vscode.ExtensionContext,
    allowStartOrRestart = true
  ): Promise<LanguageClient> {
    this.context = context;
    if (this.isInStartFailureCooldown()) {
      throw new Error("clangd start failed repeatedly. Please check OpenBMC Jump output and retry in a few seconds.");
    }

    if (this.startPromise) {
      if (!allowStartOrRestart) {
        throw new Error("clangd is starting. Try again in a moment.");
      }
      return this.startPromise;
    }

    if (!this.client) {
      if (!allowStartOrRestart) {
        throw new Error("clangd is not running.");
      }
      return this.start(context);
    }

    if (this.client.state === State.Running) {
      return this.client;
    }

    if (this.client.state === State.Starting) {
      if (!allowStartOrRestart) {
        throw new Error("clangd is starting. Try again in a moment.");
      }
      return this.start(context);
    }

    if (!allowStartOrRestart) {
      throw new Error(`clangd is not ready (state=${State[this.client.state]}).`);
    }

    return this.restart(context);
  }

  public getClient(): LanguageClient | undefined {
    return this.client;
  }

  public getStatusSnapshot(): ClangdStatusSnapshot {
    const compileDb = resolveCompileDb();
    return {
      clientState: this.client ? State[this.client.state] : "NotCreated",
      compileCommandsPath: compileDb.compileCommandsPath,
      compileCommandsIssue: compileDb.issue,
      clangdPath: this.resolveClangdPath(),
      failureStreak: this.failureStreak,
      inFailureCooldown: this.isInStartFailureCooldown(),
      isRestartPending: this.restartPending || Boolean(this.restartPromise)
    };
  }

  public getVersionSnapshot(): ClangdVersionSnapshot {
    const snapshot = getCurrentClangdSnapshot();
    const executable = snapshot.resolvedPath;
    if (!executable) {
      return snapshot;
    }

    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5000
    });

    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const firstLine = stdout?.split(/\r?\n/, 1)[0] ?? stderr?.split(/\r?\n/, 1)[0];

    return {
      ...snapshot,
      versionLine: firstLine || undefined
    };
  }

  public async stop(): Promise<void> {
    this.clearRestartTimer();
    if (!this.client) {
      return;
    }
    this.isStopping = true;
    try {
      if (this.client.state === State.Running) {
        await this.client.stop();
      }
    } catch (err) {
      this.output.appendLine(`[warn] ignore clangd stop error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.client = undefined;
      this.startPromise = undefined;
      this.isStopping = false;
    }
  }

  private async handleUnexpectedStop(): Promise<void> {
    if (this.isStopping || this.isRestarting || this.restartPending || this.startPromise) {
      return;
    }

    if (this.isInStartFailureCooldown()) {
      this.output.appendLine("[warn] suppress auto-restart during start-failure cooldown");
      return;
    }

    const autoRestart = vscode.workspace.getConfiguration("openbmcJump").get<boolean>("autoRestart", true);
    if (!autoRestart) {
      return;
    }

    if (!this.context) {
      return;
    }

    this.restartPending = true;
    const delayMs = vscode.workspace
      .getConfiguration("openbmcJump")
      .get<number>("autoRestartDelayMs", 2000);

    this.output.appendLine(`[warn] clangd stopped unexpectedly, restart in ${delayMs}ms`);
    this.restartTimer = setTimeout(async () => {
      try {
        await this.restart(this.context as vscode.ExtensionContext);
        vscode.window.showWarningMessage("OpenBMC Jump auto-restarted clangd.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[error] auto restart failed: ${msg}`);
      } finally {
        this.restartPending = false;
        this.restartTimer = undefined;
      }
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartPending = false;
  }

  private isInStartFailureCooldown(): boolean {
    if (this.failureStreak < ClangdManager.MAX_FAILURE_STREAK) {
      return false;
    }
    return Date.now() - this.lastStartFailedAt < ClangdManager.START_FAILURE_COOLDOWN_MS;
  }

  private resolveClangdPath(): string {
    const configured = vscode.workspace.getConfiguration("openbmcJump").get<string>("clangd.path", "").trim();
    return configured || "clangd";
  }
}

interface CrossCompilerInfo {
  compilerGlob: string;
  extraPaths: string[];
}

function inferCrossCompilerInfo(
  compileDbDir: string,
  output: vscode.OutputChannel
): CrossCompilerInfo | undefined {
  const compileDbPath = path.join(compileDbDir, "compile_commands.json");
  if (!fs.existsSync(compileDbPath)) {
    return undefined;
  }

  let entries: any[];
  try {
    entries = JSON.parse(fs.readFileSync(compileDbPath, "utf8"));
  } catch {
    return undefined;
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }

  const command = entries[0]?.command as string | undefined;
  if (!command) {
    return undefined;
  }

  const compilerName = command.trim().split(/\s+/)[0];
  if (!compilerName) {
    return undefined;
  }

  // Already an absolute path — use it directly
  if (path.isAbsolute(compilerName)) {
    return { compilerGlob: compilerName, extraPaths: [] };
  }

  // Bare executable name: search in recipe-sysroot-native adjacent to compileDbDir.
  // Typical layout:
  //   compileDbDir : .../tmp/work/<arch>/<pkg>/<ver>/build-subdir
  //   cross-compiler: .../tmp/work/<arch>/<pkg>/<ver>/recipe-sysroot-native/usr/bin/<arch>/<compiler>
  const versionDir = path.dirname(compileDbDir);
  const sysrootNativeBin = path.join(versionDir, "recipe-sysroot-native", "usr", "bin");
  if (!fs.existsSync(sysrootNativeBin)) {
    return undefined;
  }

  const found = findExecutableRecursively(sysrootNativeBin, compilerName, 3);
  if (!found) {
    return undefined;
  }

  output.appendLine(`[info] cross-compiler detected: ${found}`);
  return {
    compilerGlob: found,
    extraPaths: [path.dirname(found)]
  };
}

function findExecutableRecursively(
  dir: string,
  name: string,
  maxDepth: number
): string | undefined {
  if (maxDepth <= 0) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findExecutableRecursively(fullPath, name, maxDepth - 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
