const vscode = require('vscode');
const revision = require('./revision');
const blame = require('./blame');
const compare = require('./compare');

function activate(context) {
  blame.init(context);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(revision.SCHEME, new revision.GitContentProvider()),
    vscode.commands.registerCommand('gitAnnotate.toggle', () => blame.toggle()),
    vscode.commands.registerCommand('gitAnnotate.annotatePrevious', (arg) => blame.annotatePrevious(arg)),
    vscode.commands.registerCommand('gitAnnotate.showCommit', (arg) => blame.showCommit(arg)),
    vscode.commands.registerCommand('gitAnnotate.copyHash', (arg) => blame.copyHash(arg)),
    vscode.commands.registerCommand('gitAnnotate.compareWithBranch', (arg) => compare.compareWithBranch(arg)),
    vscode.window.onDidChangeVisibleTextEditors(() => blame.refreshVisible()),
    vscode.window.onDidChangeActiveTextEditor((editor) => blame.maybeAutoAnnotate(editor)),
    vscode.workspace.onDidSaveTextDocument((document) => blame.onDocSave(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitAnnotate')) {
        blame.recomputeAll();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => blame.recomputeAll()),
  );

  blame.maybeAutoAnnotate(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
