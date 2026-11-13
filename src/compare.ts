import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as git from './git';
import * as revision from './revision';
import type { NameStatusEntry } from './types';

const STATUS_ICON: Record<string, string> = {
  A: '$(diff-added)',
  D: '$(diff-removed)',
  M: '$(diff-modified)',
  R: '$(diff-renamed)',
  C: '$(diff-renamed)',
};

interface DiffPair {
  originalUri?: vscode.Uri;
  modifiedUri?: vscode.Uri;
}

function fileUri(root: string, relpath: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, relpath));
}

// Original = branch version, Modified = working tree version (undefined side = added/deleted).
// For an added file we still point the original at the branch revision of newPath: it resolves
// to '' (the file is absent there), which renders as a clean insertion instead of a phantom
// deleted first line — the red band the undefined-original placeholder would produce.
function diffPair(root: string, branch: string, entry: NameStatusEntry): DiffPair {
  const originalPath = entry.oldPath || entry.newPath;
  return {
    originalUri: originalPath ? revision.buildRevisionUri(root, branch, originalPath) : undefined,
    modifiedUri: entry.newPath ? fileUri(root, entry.newPath) : undefined,
  };
}

async function pickBranch(root: string): Promise<string | null> {
  const [branches, current] = await Promise.all([git.listBranches(root), git.currentBranch(root)]);
  const items = branches.filter((branch) => branch !== current).map((branch) => ({ label: branch }));
  if (items.length === 0) {
    vscode.window.showInformationMessage('Git Blame: no other branch to compare against.');
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Compare against… (current: ${current})`,
  });
  return picked ? picked.label : null;
}

async function openFileDiff(root: string, branch: string, relpath: string, uri: vscode.Uri): Promise<void> {
  const left = revision.buildRevisionUri(root, branch, relpath);
  const title = `${path.basename(relpath)} (${branch} ↔ working)`;
  await vscode.commands.executeCommand('vscode.diff', left, uri, title);
}

async function fallbackQuickPick(root: string, branch: string, entries: NameStatusEntry[]): Promise<void> {
  const items = entries.map((entry) => ({
    label: `${STATUS_ICON[entry.status] || ''} ${entry.newPath || entry.oldPath}`,
    entry,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Changes vs ${branch} — pick a file to diff`,
  });
  if (!picked) {
    return;
  }
  const { originalUri, modifiedUri } = diffPair(root, branch, picked.entry);
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri || revision.buildRevisionUri(root, branch, picked.entry.newPath ?? ''),
    // A deleted file has no working side: diff it against an empty document,
    // so it shows as a full deletion like in the multi-diff editor.
    modifiedUri || revision.buildEmptyUri(picked.entry.oldPath ?? ''),
    `${picked.label} (${branch} ↔ working)`,
  );
}

export async function compareWithBranch(arg: unknown): Promise<void> {
  const resource =
    arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (!resource || resource.scheme !== 'file') {
    vscode.window.showErrorMessage('Git Blame: select a file or folder to compare.');
    return;
  }

  try {
    const fsPath = resource.fsPath;
    const isDirectory = fs.statSync(fsPath).isDirectory();
    const { root, relpath: dirRelpath } = await git.locate(isDirectory ? fsPath : path.dirname(fsPath));
    const branch = await pickBranch(root);
    if (!branch) {
      return;
    }

    if (!isDirectory) {
      await openFileDiff(root, branch, path.posix.join(dirRelpath, path.basename(fsPath)), resource);
      return;
    }

    const entries = await git.diffNameStatus(root, branch, dirRelpath || undefined);
    if (entries.length === 0) {
      vscode.window.showInformationMessage(`Git Blame: no differences with ${branch}.`);
      return;
    }

    const resources = entries.map((entry) => diffPair(root, branch, entry));
    try {
      await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
        title: `Diff vs ${branch}`,
        multiDiffSourceUri: vscode.Uri.from({
          scheme: revision.SCHEME,
          path: '/diff',
          query: `ref=${encodeURIComponent(branch)}`,
        }),
        resources,
      });
    } catch {
      await fallbackQuickPick(root, branch, entries);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Git Blame: ${(error as Error).message}`);
  }
}
