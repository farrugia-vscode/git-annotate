import * as vscode from 'vscode';
import * as revision from './revision';
import * as compare from './compare';
import { BlameController } from './blame';

let controller: BlameController;

export function activate(context: vscode.ExtensionContext): void {
  controller = new BlameController(context);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(revision.SCHEME, new revision.GitContentProvider()),
    vscode.commands.registerCommand('gitAnnotate.toggle', () => controller.toggle()),
    vscode.commands.registerCommand('gitAnnotate.annotatePrevious', (arg) => controller.annotatePrevious(arg)),
    vscode.commands.registerCommand('gitAnnotate.showCommit', (arg) => controller.showCommit(arg)),
    vscode.commands.registerCommand('gitAnnotate.copyHash', (arg) => controller.copyHash(arg)),
    vscode.commands.registerCommand('gitAnnotate.compareWithBranch', (arg) => compare.compareWithBranch(arg)),
    vscode.window.onDidChangeVisibleTextEditors(() => controller.refreshVisible()),
    vscode.window.onDidChangeActiveTextEditor((editor) => controller.maybeAutoAnnotate(editor)),
    vscode.workspace.onDidSaveTextDocument((document) => controller.onDocSave(document)),
    vscode.workspace.onDidCloseTextDocument((document) => controller.onDocClose(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitAnnotate')) {
        controller.recomputeAll();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => controller.recomputeAll()),
  );

  controller.maybeAutoAnnotate(vscode.window.activeTextEditor);
}

export function deactivate(): void {}
