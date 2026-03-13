import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State
} from "vscode-languageclient/node";
import { resolveCompileDb } from "../context/compileDb";

export interface ClangdStatusSnapshot {
  clientState: string;
  compileCommandsPath?: string;
  compileCommandsIssue?: string;
  clangdPath: string;
  failureStreak: number;
  inFailureCooldown: boolean;
  isRestartPending: boolean;
}

export class ClangdManager {
  private client: LanguageClient | undefined;
  private readonly output = vscode.window.createOutputChannel("OpenBMC Jump");
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
          extraEnv.PATH = `${crossInfo.extraPaths.join(":")}:${process.env.PATH ?? ""}`;
        }
      }
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
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        closed: () => ({ action: CloseAction.DoNotRestart })
      }
    };

    this.output.appendLine(`[info] starting clangd: ${clangdPath} ${args.join(" ")}`);

    this.client = new LanguageClient("openbmcJumpClangd", "OpenBMC Jump clangd", serverOptions, clientOptions);
    const activeClient = this.client;
    this.client.onDidChangeState((event) => {
      if (this.client !== activeClient) {
        return;
      }
      this.output.appendLine(`[state] ${State[event.oldState]} -> ${State[event.newState]}`);
      if (event.newState === State.Stopped) {
        void this.handleUnexpectedStop();
      }
    });

    context.subscriptions.push(this.client);
    this.startPromise = (async () => {
      try {
        await this.client!.start();
        this.failureStreak = 0;
        this.output.appendLine("[info] clangd is ready");
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
