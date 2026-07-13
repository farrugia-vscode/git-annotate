const path = require('path');
const vscode = require('vscode');
const git = require('./git');
const revision = require('./revision');
const format = require('./format');

let decorationType = null;
// uriString -> { target, options }
const annotated = new Map();

function init(context) {
  decorationType = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      backgroundColor: new vscode.ThemeColor('editorGutter.background'),
      margin: '0 1em 0 0',
      height: '100%',
      // Force upright: on comment/docblock lines the token style is italic and would slant the text
      // and the `│` separator (making it look like a `/`).
      fontStyle: 'normal',
      // CSS injection hack: `white-space: pre` preserves the space padding (no collapsing, no
      // trailing trim) so we can pad with regular spaces (uniform width) instead of nbsp.
      textDecoration: 'none; white-space: pre',
    },
  });
  context.subscriptions.push(decorationType);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration('gitAnnotate');
  return {
    template: config.get('template') ?? '${date} ${author}',
    hashLength: config.get('hashLength') ?? 8,
    dateFormat: config.get('dateFormat') ?? 'iso',
    authorFormat: config.get('authorFormat') ?? 'last',
    heatmap: config.get('heatmap') ?? true,
    oldColor: config.get('heatmapOldColor') ?? '#f14c4c',
    newColor: config.get('heatmapNewColor') ?? '#4ec94e',
    maxWidth: config.get('maxWidth') ?? 60,
    autoAnnotate: config.get('autoAnnotate') ?? false,
  };
}

function isDarkTheme() {
  const theme = vscode.window.activeColorTheme;
  const kinds = vscode.ColorThemeKind || {};
  if (!theme) {
    return true;
  }
  return theme.kind === kinds.Dark || theme.kind === kinds.HighContrast;
}

const COLUMN_SEP = '│';

// Render one annotation cell: clip to `width`, pad to the same length with REGULAR spaces, append a
// `│` separator. Regular spaces have the exact same advance as any other char (monospace + uniform
// letterSpacing), unlike nbsp — so lines with different letter/padding ratios still align. Collapse
// and trailing-trim are prevented by `white-space: pre` set on the decoration (see init()).
function renderColumn(text, width) {
  const clipped = text.length > width ? text.slice(0, width - 1) + '…' : text;
  return clipped.padEnd(width, ' ') + ' ' + COLUMN_SEP;
}

function buildHover(entry, ctx) {
  const hover = new vscode.MarkdownString(undefined, true);
  hover.isTrusted = true;
  if (entry.isUncommitted) {
    hover.appendMarkdown('*Not committed yet*');
    return hover;
  }
  const date = new Date(entry.authorTime * 1000).toLocaleString();
  hover.appendMarkdown(`**${entry.summary || ''}**\n\n`);
  hover.appendMarkdown(`${entry.author}${entry.email ? ` <${entry.email}>` : ''}\n\n`);
  hover.appendMarkdown(`${date} · \`${entry.hash.slice(0, 8)}\`\n\n`);

  if (entry.previousHash) {
    const prevArgs = encodeURIComponent(JSON.stringify([{ uri: ctx.uriString, line: ctx.line }]));
    hover.appendMarkdown(`[$(history) Annotate previous](command:gitAnnotate.annotatePrevious?${prevArgs}) · `);
  }
  const diffArgs = encodeURIComponent(JSON.stringify([{ root: ctx.root, hash: entry.hash, path: ctx.relpath }]));
  hover.appendMarkdown(`[$(git-commit) Show diff](command:gitAnnotate.showCommit?${diffArgs}) · `);
  const copyArgs = encodeURIComponent(JSON.stringify([entry.hash]));
  hover.appendMarkdown(`[$(copy) Copy hash](command:gitAnnotate.copyHash?${copyArgs})`);
  return hover;
}

function buildOptions(entries, ctx, config) {
  const texts = entries.map((entry) => format.renderLineText(entry, config, false));
  const width = Math.min(
    config.maxWidth,
    Math.max(1, ...texts.filter((text) => text !== null).map((text) => text.length)),
  );

  const times = entries.filter((entry) => !entry.isUncommitted && entry.authorTime).map((entry) => entry.authorTime);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const isDark = isDarkTheme();

  return entries.map((entry, index) => {
    const before = { contentText: renderColumn(texts[index] || '', width) };
    if (config.heatmap) {
      let ratio = 1;
      if (!entry.isUncommitted && entry.authorTime && newest > oldest) {
        ratio = (entry.authorTime - oldest) / (newest - oldest);
      }
      before.color = format.heatColor(ratio, config.oldColor, config.newColor, isDark);
    }
    return {
      range: new vscode.Range(index, 0, index, 0),
      hoverMessage: buildHover(entry, { ...ctx, line: index }),
      renderOptions: { before },
    };
  });
}

function applyToVisible(uriString) {
  const record = annotated.get(uriString);
  const options = record ? record.options : [];
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriString) {
      editor.setDecorations(decorationType, options);
    }
  }
}

function clear(uriString) {
  annotated.delete(uriString);
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriString) {
      editor.setDecorations(decorationType, []);
    }
  }
}

function refreshVisible() {
  for (const editor of vscode.window.visibleTextEditors) {
    const record = annotated.get(editor.document.uri.toString());
    editor.setDecorations(decorationType, record ? record.options : []);
  }
}

// Do NOT clear on edit — that would close the annotation the user opened. VSCode shifts the existing
// decorations with the text automatically; we just refresh the blame on save (below), when the disk
// matches the editor and edited lines can turn into "Uncommitted".
async function onDocSave(document) {
  const record = annotated.get(document.uri.toString());
  if (!record) {
    return;
  }
  try {
    await applyBlame(document, record.target);
  } catch {
    // Keep the current (shifted) decorations if the refresh fails.
  }
}

// Resolve where to read blame from, for both real files and historical virtual docs.
async function resolveTarget(document) {
  if (document.uri.scheme === revision.SCHEME) {
    return revision.parseRevisionUri(document.uri);
  }
  if (document.uri.scheme !== 'file') {
    throw new Error('Only local files can be annotated');
  }
  const fsPath = document.uri.fsPath;
  const root = await git.getRepoRoot(path.dirname(fsPath));
  return { root, rev: null, relpath: path.relative(root, fsPath) };
}

async function applyBlame(document, target) {
  const entries = await git.blame(target.root, target.rev, target.relpath);
  const uriString = document.uri.toString();
  const options = buildOptions(entries, { uriString, root: target.root, relpath: target.relpath }, getConfig());
  annotated.set(uriString, { target, options });
  applyToVisible(uriString);
}

async function recomputeAll() {
  for (const [uriString, record] of [...annotated.entries()]) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
      await applyBlame(document, record.target);
    } catch {
      // Document no longer available — drop it silently.
    }
  }
}

// True when the currently active tab is a (multi-)diff editor. Kept narrow (active tab only)
// so a file open normally still gets annotated even if it also appears in a diff tab elsewhere.
function activeTabIsDiff() {
  const groups = vscode.window.tabGroups;
  const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (!input) {
    return false;
  }
  return (
    (vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff) ||
    (vscode.TabInputTextMultiDiff && input instanceof vscode.TabInputTextMultiDiff)
  );
}

// Annotate on open when enabled, mimicking an always-on blame. Silent on non-git files.
async function maybeAutoAnnotate(editor) {
  if (!editor || !getConfig().autoAnnotate) {
    return;
  }
  const scheme = editor.document.uri.scheme;
  if ((scheme !== 'file' && scheme !== revision.SCHEME) || annotated.has(editor.document.uri.toString())) {
    return;
  }
  if (activeTabIsDiff()) {
    return;
  }
  try {
    await applyBlame(editor.document, await resolveTarget(editor.document));
  } catch {
    // Not a git-tracked file — leave it un-annotated silently.
  }
}

async function toggle() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const uriString = editor.document.uri.toString();
  if (annotated.has(uriString)) {
    clear(uriString);
    return;
  }
  try {
    await applyBlame(editor.document, await resolveTarget(editor.document));
  } catch (error) {
    vscode.window.showErrorMessage(`Git Blame: ${error.message}`);
  }
}

function isLineArg(arg) {
  return arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) && 'uri' in arg && 'line' in arg;
}

async function annotatePrevious(arg) {
  try {
    let documentUri;
    let line;
    if (isLineArg(arg)) {
      // Hover command link.
      documentUri = vscode.Uri.parse(arg.uri);
      line = arg.line;
    } else if (arg && typeof arg === 'object' && typeof arg.lineNumber === 'number') {
      // Gutter line-number context menu (lineNumber is 1-based).
      const editor = vscode.window.activeTextEditor;
      documentUri = arg.uri instanceof vscode.Uri ? arg.uri : editor && editor.document.uri;
      line = arg.lineNumber - 1;
    } else {
      // Editor context menu or command palette.
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      documentUri = editor.document.uri;
      line = editor.selection.active.line;
    }
    if (!documentUri) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(documentUri);
    const target = await resolveTarget(document);
    const entries = await git.blame(target.root, target.rev, target.relpath);
    const entry = entries[line];
    if (!entry || entry.isUncommitted) {
      vscode.window.showInformationMessage('Git Blame: line not committed yet.');
      return;
    }
    if (!entry.previousHash) {
      vscode.window.showInformationMessage('Git Blame: no previous revision (initial commit).');
      return;
    }

    const shortHash = entry.previousHash.slice(0, getConfig().hashLength);
    const label = `${path.basename(entry.previousPath)} (${shortHash})`;
    const uri = revision.buildRevisionUri(target.root, entry.previousHash, entry.previousPath, label);
    const previousDoc = await vscode.workspace.openTextDocument(uri);
    if (document.languageId && document.languageId !== 'plaintext') {
      try {
        await vscode.languages.setTextDocumentLanguage(previousDoc, document.languageId);
      } catch {
        // Unknown language id — keep the auto-detected one.
      }
    }
    const editor = await vscode.window.showTextDocument(previousDoc, { preview: false });
    await applyBlame(previousDoc, { root: target.root, rev: entry.previousHash, relpath: entry.previousPath });

    const revealLine = Math.min(line, Math.max(0, previousDoc.lineCount - 1));
    editor.selection = new vscode.Selection(revealLine, 0, revealLine, 0);
    editor.revealRange(new vscode.Range(revealLine, 0, revealLine, 0), vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    vscode.window.showErrorMessage(`Git Blame: ${error.message}`);
  }
}

async function showCommit(arg) {
  if (!arg || !arg.hash) {
    return;
  }
  const left = revision.buildRevisionUri(arg.root, `${arg.hash}^`, arg.path);
  const right = revision.buildRevisionUri(arg.root, arg.hash, arg.path);
  const title = `${path.basename(arg.path)} @ ${arg.hash.slice(0, 8)}`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

async function copyHash(hash) {
  if (!hash) {
    return;
  }
  await vscode.env.clipboard.writeText(hash);
  vscode.window.showInformationMessage(`Git Blame: copied ${hash.slice(0, 8)}`);
}

module.exports = {
  init,
  toggle,
  maybeAutoAnnotate,
  annotatePrevious,
  showCommit,
  copyHash,
  refreshVisible,
  recomputeAll,
  onDocSave,
};
