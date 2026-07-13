// Pure Node git helpers — no vscode dependency, so this module is unit-testable headless.
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function run(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  return stdout;
}

async function getRepoRoot(cwd) {
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) {
    throw new Error('Not a git repository');
  }
  return root;
}

async function currentBranch(root) {
  return (await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

async function listBranches(root) {
  const output = await run(root, ['branch', '-a', '--format=%(refname:short)']);
  const seen = new Set();
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(' -> ') && !line.endsWith('/HEAD'))
    .filter((line) => {
      if (seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    });
}

// Returns the file content at a given revision, or '' when the path is absent there.
async function showFile(root, rev, relpath) {
  try {
    return await run(root, ['show', `${rev}:${relpath}`]);
  } catch {
    return '';
  }
}

function parseBlame(output) {
  const entries = [];
  let current = null;
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current) {
        entries.push(current);
      }
      current = null;
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(raw);
    if (header) {
      current = { hash: header[1], isUncommitted: /^0+$/.test(header[1]) };
      continue;
    }
    if (!current) {
      continue;
    }
    const spaceIndex = raw.indexOf(' ');
    const key = spaceIndex === -1 ? raw : raw.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1);
    if (key === 'author') {
      current.author = value;
    } else if (key === 'author-mail') {
      current.email = value.replace(/[<>]/g, '');
    } else if (key === 'author-time') {
      current.authorTime = parseInt(value, 10);
    } else if (key === 'summary') {
      current.summary = value;
    } else if (key === 'previous') {
      const parts = value.split(' ');
      current.previousHash = parts[0];
      current.previousPath = parts.slice(1).join(' ');
    }
  }
  return entries;
}

// One entry per source line (0-indexed). rev = null blames the working tree.
async function blame(root, rev, relpath) {
  const args = ['blame', '--line-porcelain'];
  if (rev) {
    args.push(rev);
  }
  args.push('--', relpath);
  return parseBlame(await run(root, args));
}

function parseNameStatus(output) {
  const entries = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0][0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, oldPath: parts[1], newPath: parts[2] });
    } else if (status === 'A') {
      entries.push({ status, newPath: parts[1] });
    } else if (status === 'D') {
      entries.push({ status, oldPath: parts[1] });
    } else {
      entries.push({ status, oldPath: parts[1], newPath: parts[1] });
    }
  }
  return entries;
}

// Changes from `ref` (original) to the working tree (modified), optionally scoped to a path.
async function diffNameStatus(root, ref, relpath) {
  const args = ['diff', '--name-status', '-M', ref, '--'];
  if (relpath) {
    args.push(relpath);
  }
  return parseNameStatus(await run(root, args));
}

module.exports = {
  getRepoRoot,
  currentBranch,
  listBranches,
  showFile,
  blame,
  diffNameStatus,
  parseBlame,
  parseNameStatus,
};
