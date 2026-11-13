import * as vscode from 'vscode';
import * as git from './git';
import type { RevisionTarget } from './types';

export const SCHEME = 'git-annotate';

// Read-only virtual URI pointing at a file as it was at a given revision.
// `label` overrides only the displayed tab name; content still resolves from the query.
export function buildRevisionUri(root: string, rev: string, relpath: string, label?: string): vscode.Uri {
  const query = new URLSearchParams({ root, rev, path: relpath }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + (label || relpath), query });
}

// Read-only virtual URI with no content, used as the missing side of a diff
// (for example the working side of a deleted file).
export function buildEmptyUri(relpath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + relpath });
}

export function parseRevisionUri(uri: vscode.Uri): RevisionTarget {
  const params = new URLSearchParams(uri.query);
  return {
    root: params.get('root') ?? '',
    rev: params.get('rev'),
    relpath: params.get('path') ?? '',
  };
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, rev, relpath } = parseRevisionUri(uri);
    // No revision means an empty side (see buildEmptyUri).
    if (!rev) {
      return Promise.resolve('');
    }
    return git.showFile(root, rev, relpath);
  }
}
