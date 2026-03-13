import * as vscode from "vscode";

export interface PerfEvent {
  operation: string;
  elapsedMs: number;
  resultCount: number;
  success: boolean;
}

export class MetricsCollector implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("OpenBMC Jump Metrics");
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private totalRequests = 0;
  private failedRequests = 0;
  private zeroResultRequests = 0;
  private cumulativeMs = 0;

  constructor() {
    this.statusBar.name = "OpenBMC Jump Metrics";
    this.statusBar.text = "OpenBMC Jump: idle";
    this.statusBar.tooltip = "OpenBMC Jump performance metrics";
    this.statusBar.command = "openbmcJump.showMetrics";
    this.statusBar.show();
  }

  public record(event: PerfEvent): void {
    this.totalRequests += 1;
    if (!event.success) {
      this.failedRequests += 1;
    }
    if (event.resultCount === 0) {
      this.zeroResultRequests += 1;
    }
    this.cumulativeMs += event.elapsedMs;

    const avg = this.totalRequests > 0 ? this.cumulativeMs / this.totalRequests : 0;
    const resultText = event.resultCount === 0 ? "0 results" : `${event.resultCount} results`;
    const okText = event.success ? "ok" : "fail";
    this.statusBar.text = `OpenBMC Jump: ${Math.round(event.elapsedMs)}ms ${resultText}`;
    this.statusBar.tooltip = `Requests: ${this.totalRequests}, Failures: ${this.failedRequests}, ZeroResults: ${this.zeroResultRequests}, Avg: ${avg.toFixed(1)}ms, Last: ${okText}`;

    this.output.appendLine(
      `[perf] op=${event.operation} elapsedMs=${event.elapsedMs.toFixed(1)} resultCount=${event.resultCount} success=${event.success}`
    );
  }

  public show(): void {
    const avg = this.totalRequests > 0 ? this.cumulativeMs / this.totalRequests : 0;
    this.output.appendLine(
      `[summary] total=${this.totalRequests} failed=${this.failedRequests} zeroResult=${this.zeroResultRequests} avgMs=${avg.toFixed(1)}`
    );
    this.output.show(true);
  }

  public dispose(): void {
    this.statusBar.dispose();
    this.output.dispose();
  }
}
