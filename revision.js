const vscode = require('vscode');
const git = require('./git');

const SCHEME = 'git-annotate';

// Read-only virtual URI pointing at a file as it was at a given revision.
// `label` overrides only the displayed tab name; content still resolves from the query.
function buildRevisionUri(root, rev, relpath, label) {
  const query = new URLSearchParams({ root, rev, path: relpath }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + (label || relpath), query });
}

function parseRevisionUri(uri) {
  const params = new URLSearchParams(uri.query);
  return {
    root: params.get('root'),
    rev: params.get('rev'),
    relpath: params.get('path'),
  };
}

class GitContentProvider {
  provideTextDocumentContent(uri) {
    const { root, rev, relpath } = parseRevisionUri(uri);
    return git.showFile(root, rev, relpath);
  }
}

module.exports = { SCHEME, buildRevisionUri, parseRevisionUri, GitContentProvider };
