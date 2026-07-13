import * as path from 'path';
import * as vscode from 'vscode';
import * as git from './git';
import * as revision from './revision';
import * as format from './format';
import type { BlameEntry, Config, RevisionTarget } from './types';

interface AnnotationRecord {
  target: RevisionTarget;
  options: vscode.DecorationOptions[];
}

interface HoverContext {
  uriString: string;
  root: string;
  relpath: string;
  line: number;
}

const COLUMN_SEP = '│';

// A hover command-link argument ({uri, line}) as encoded in buildHover.
function isLineArg(arg: unknown): arg is { uri: string; line: number } {
  return !!arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) && 'uri' in arg && 'line' in arg;
}

/**
 * Owns the blame decoration type and the per-document annotation state, and
 * exposes the commands/handlers wired in extension.ts. Behaviour is identical
 * to the original module — only the shared state is now encapsulated here.
 */
export class BlameController {
  private readonly decorationType: vscode.TextEditorDecorationType;
  // uriString -> { target, options }
  private readonly annotated = new Map<string, AnnotationRecord>();

  constructor(context: vscode.ExtensionContext) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
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
    context.subscriptions.push(this.decorationType);
  }

  private getConfig(): Config {
    const config = vscode.workspace.getConfiguration('gitAnnotate');
    return {
      template: config.get<string>('template') ?? '${date} ${author}',
      hashLength: config.get<number>('hashLength') ?? 8,
      dateFormat: config.get<string>('dateFormat') ?? 'iso',
      authorFormat: config.get<string>('authorFormat') ?? 'last',
      heatmap: config.get<boolean>('heatmap') ?? true,
      oldColor: config.get<string>('heatmapOldColor') ?? '#f14c4c',
      newColor: config.get<string>('heatmapNewColor') ?? '#4ec94e',
      maxWidth: config.get<number>('maxWidth') ?? 60,
      autoAnnotate: config.get<boolean>('autoAnnotate') ?? false,
    };
  }

  private isDarkTheme(): boolean {
    const theme = vscode.window.activeColorTheme;
    const kinds = vscode.ColorThemeKind;
    if (!theme) {
      return true;
    }
    return theme.kind === kinds.Dark || theme.kind === kinds.HighContrast;
  }

  // Render one annotation cell: clip to `width`, pad to the same length with REGULAR spaces, append a
  // `│` separator. Regular spaces have the exact same advance as any other char (monospace + uniform
  // letterSpacing), unlike nbsp — so lines with different letter/padding ratios still align. Collapse
  // and trailing-trim are prevented by `white-space: pre` set on the decoration (see constructor).
  private renderColumn(text: string, width: number): string {
    const clipped = text.length > width ? text.slice(0, width - 1) + '…' : text;
    return clipped.padEnd(width, ' ') + ' ' + COLUMN_SEP;
  }

  private buildHover(entry: BlameEntry, ctx: HoverContext): vscode.MarkdownString {
    const hover = new vscode.MarkdownString(undefined, true);
    hover.isTrusted = true;
    if (entry.isUncommitted) {
      hover.appendMarkdown('*Not committed yet*');
      return hover;
    }
    const date = new Date((entry.authorTime ?? 0) * 1000).toLocaleString();
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

  private buildOptions(entries: BlameEntry[], ctx: Omit<HoverContext, 'line'>, config: Config): vscode.DecorationOptions[] {
    const texts = entries.map((entry) => format.renderLineText(entry, config, false));
    const width = Math.min(
      config.maxWidth,
      Math.max(1, ...texts.filter((text): text is string => text !== null).map((text) => text.length)),
    );

    const times = entries
      .filter((entry) => !entry.isUncommitted && entry.authorTime)
      .map((entry) => entry.authorTime as number);
    const oldest = Math.min(...times);
    const newest = Math.max(...times);
    const isDark = this.isDarkTheme();

    return entries.map((entry, index) => {
      const before: vscode.ThemableDecorationAttachmentRenderOptions = {
        contentText: this.renderColumn(texts[index] || '', width),
      };
      if (config.heatmap) {
        let ratio = 1;
        if (!entry.isUncommitted && entry.authorTime && newest > oldest) {
          ratio = (entry.authorTime - oldest) / (newest - oldest);
        }
        before.color = format.heatColor(ratio, config.oldColor, config.newColor, isDark);
      }
      return {
        range: new vscode.Range(index, 0, index, 0),
        hoverMessage: this.buildHover(entry, { ...ctx, line: index }),
        renderOptions: { before },
      };
    });
  }

  private applyToVisible(uriString: string): void {
    const record = this.annotated.get(uriString);
    const options = record ? record.options : [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uriString) {
        editor.setDecorations(this.decorationType, options);
      }
    }
  }

  private clear(uriString: string): void {
    this.annotated.delete(uriString);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uriString) {
        editor.setDecorations(this.decorationType, []);
      }
    }
  }

  refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const record = this.annotated.get(editor.document.uri.toString());
      editor.setDecorations(this.decorationType, record ? record.options : []);
    }
  }

  // Do NOT clear on edit — that would close the annotation the user opened. VSCode shifts the existing
  // decorations with the text automatically; we just refresh the blame on save (below), when the disk
  // matches the editor and edited lines can turn into "Uncommitted".
  async onDocSave(document: vscode.TextDocument): Promise<void> {
    const record = this.annotated.get(document.uri.toString());
    if (!record) {
      return;
    }
    try {
      await this.applyBlame(document, record.target);
    } catch {
      // Keep the current (shifted) decorations if the refresh fails.
    }
  }

  // Resolve where to read blame from, for both real files and historical virtual docs.
  private async resolveTarget(document: vscode.TextDocument): Promise<RevisionTarget> {
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

  private async applyBlame(document: vscode.TextDocument, target: RevisionTarget): Promise<void> {
    const entries = await git.blame(target.root, target.rev, target.relpath);
    const uriString = document.uri.toString();
    const options = this.buildOptions(entries, { uriString, root: target.root, relpath: target.relpath }, this.getConfig());
    this.annotated.set(uriString, { target, options });
    this.applyToVisible(uriString);
  }

  async recomputeAll(): Promise<void> {
    for (const [uriString, record] of [...this.annotated.entries()]) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
        await this.applyBlame(document, record.target);
      } catch {
        // Document no longer available — drop it silently.
      }
    }
  }

  // True when the currently active tab is a (multi-)diff editor. Kept narrow (active tab only)
  // so a file open normally still gets annotated even if it also appears in a diff tab elsewhere.
  private activeTabIsDiff(): boolean {
    const groups = vscode.window.tabGroups;
    const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    if (!input) {
      return false;
    }
    // TabInputTextMultiDiff is a newer API and may be absent at runtime — access it defensively.
    type DiffCtor = new (...args: never[]) => object;
    const multiDiffCtor = (vscode as unknown as { TabInputTextMultiDiff?: DiffCtor }).TabInputTextMultiDiff;
    return (
      input instanceof vscode.TabInputTextDiff ||
      (multiDiffCtor !== undefined && input instanceof multiDiffCtor)
    );
  }

  // Annotate on open when enabled, mimicking an always-on blame. Silent on non-git files.
  async maybeAutoAnnotate(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || !this.getConfig().autoAnnotate) {
      return;
    }
    const scheme = editor.document.uri.scheme;
    if ((scheme !== 'file' && scheme !== revision.SCHEME) || this.annotated.has(editor.document.uri.toString())) {
      return;
    }
    if (this.activeTabIsDiff()) {
      return;
    }
    try {
      await this.applyBlame(editor.document, await this.resolveTarget(editor.document));
    } catch {
      // Not a git-tracked file — leave it un-annotated silently.
    }
  }

  async toggle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const uriString = editor.document.uri.toString();
    if (this.annotated.has(uriString)) {
      this.clear(uriString);
      return;
    }
    try {
      await this.applyBlame(editor.document, await this.resolveTarget(editor.document));
    } catch (error) {
      vscode.window.showErrorMessage(`Git Blame: ${(error as Error).message}`);
    }
  }

  async annotatePrevious(arg: unknown): Promise<void> {
    try {
      let documentUri: vscode.Uri | undefined;
      let line = 0;
      if (isLineArg(arg)) {
        // Hover command link.
        documentUri = vscode.Uri.parse(arg.uri);
        line = arg.line;
      } else if (arg && typeof arg === 'object' && typeof (arg as { lineNumber?: unknown }).lineNumber === 'number') {
        // Gutter line-number context menu (lineNumber is 1-based).
        const gutter = arg as { lineNumber: number; uri?: unknown };
        const editor = vscode.window.activeTextEditor;
        documentUri = gutter.uri instanceof vscode.Uri ? gutter.uri : editor && editor.document.uri;
        line = gutter.lineNumber - 1;
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
      const target = await this.resolveTarget(document);
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

      const shortHash = entry.previousHash.slice(0, this.getConfig().hashLength);
      const label = `${path.basename(entry.previousPath ?? '')} (${shortHash})`;
      const uri = revision.buildRevisionUri(target.root, entry.previousHash, entry.previousPath ?? '', label);
      const previousDoc = await vscode.workspace.openTextDocument(uri);
      if (document.languageId && document.languageId !== 'plaintext') {
        try {
          await vscode.languages.setTextDocumentLanguage(previousDoc, document.languageId);
        } catch {
          // Unknown language id — keep the auto-detected one.
        }
      }
      const editor = await vscode.window.showTextDocument(previousDoc, { preview: false });
      await this.applyBlame(previousDoc, { root: target.root, rev: entry.previousHash, relpath: entry.previousPath ?? '' });

      const revealLine = Math.min(line, Math.max(0, previousDoc.lineCount - 1));
      editor.selection = new vscode.Selection(revealLine, 0, revealLine, 0);
      editor.revealRange(new vscode.Range(revealLine, 0, revealLine, 0), vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      vscode.window.showErrorMessage(`Git Blame: ${(error as Error).message}`);
    }
  }

  async showCommit(arg: { root: string; hash: string; path: string } | undefined): Promise<void> {
    if (!arg || !arg.hash) {
      return;
    }
    const left = revision.buildRevisionUri(arg.root, `${arg.hash}^`, arg.path);
    const right = revision.buildRevisionUri(arg.root, arg.hash, arg.path);
    const title = `${path.basename(arg.path)} @ ${arg.hash.slice(0, 8)}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  async copyHash(hash: string | undefined): Promise<void> {
    if (!hash) {
      return;
    }
    await vscode.env.clipboard.writeText(hash);
    vscode.window.showInformationMessage(`Git Blame: copied ${hash.slice(0, 8)}`);
  }
}
