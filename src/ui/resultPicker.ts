import * as vscode from "vscode";

export async function openFirstOrPick(locations: vscode.Location[]): Promise<void> {
  if (locations.length === 0) {
    vscode.window.showWarningMessage("OpenBMC Jump did not find a target location.");
    return;
  }

  if (locations.length === 1) {
    await openLocation(locations[0]);
    return;
  }

  const picks = locations.map((loc) => {
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return {
      label: `${loc.uri.fsPath}:${line}:${col}`,
      description: "Candidate target",
      location: loc
    };
  });

  const picked = await vscode.window.showQuickPick(picks, {
    title: "Multiple targets found",
    placeHolder: "Select a navigation target"
  });

  if (picked) {
    await openLocation(picked.location);
  }
}

async function openLocation(location: vscode.Location): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(location.range.start, location.range.start);
  editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
}
