import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { blame, locate, parseBlame, parseNameStatus, unquotePath } from '../src/git';

let sandbox: string;
let repo: string;

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// History: "old name.txt" (2 lines), renamed to "café x.txt", then a third line added.
beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-annotate-')));
  repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, 'sub dir'), { recursive: true });
  runGit(repo, 'init', '-q');
  runGit(repo, 'config', 'user.email', 'a@b.c');
  runGit(repo, 'config', 'user.name', 'A B');
  fs.writeFileSync(path.join(repo, 'old name.txt'), 'one\ntwo\n');
  runGit(repo, 'add', '.');
  runGit(repo, 'commit', '-qm', 'init');
  runGit(repo, 'mv', 'old name.txt', 'café x.txt');
  runGit(repo, 'commit', '-qm', 'rename');
  fs.writeFileSync(path.join(repo, 'café x.txt'), 'one\ntwo\nthree\n');
  runGit(repo, 'commit', '-qam', 'add three');
  fs.symlinkSync(repo, path.join(sandbox, 'link'));
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('unquotePath', () => {
  it.each([
    ['plain', 'a b.txt', 'a b.txt'],
    ['octal UTF-8 bytes', '"caf\\303\\251 x.txt"', 'café x.txt'],
    ['quote and backslash', '"a\\"b\\\\c"', 'a"b\\c'],
    ['tab', '"a\\tb"', 'a\tb'],
  ])('reads a %s path', (_name, raw, expected) => {
    expect(unquotePath(raw)).toBe(expected);
  });
});

describe('parseBlame', () => {
  it('reads SHA-256 hashes', () => {
    const hash = 'a'.repeat(64);
    const entries = parseBlame(`${hash} 1 1 1\nauthor A\nfilename f\n\tline\n`);
    expect(entries.map((entry) => entry.hash)).toEqual([hash]);
  });
});

describe('parseNameStatus', () => {
  it('unquotes a renamed non-ASCII path', () => {
    expect(parseNameStatus('R057\told name.txt\t"caf\\303\\251 x.txt"\n')).toEqual([
      { status: 'R', oldPath: 'old name.txt', newPath: 'café x.txt' },
    ]);
  });
});

describe('blame', () => {
  it('gives the path of each line in its own commit, after a rename', async () => {
    const entries = await blame(repo, null, 'café x.txt');
    expect(entries.map((entry) => entry.filename)).toEqual(['old name.txt', 'old name.txt', 'café x.txt']);
    expect(entries[2].previousPath).toBe('café x.txt');
  });

  it('blames the given text instead of the file on disk', async () => {
    const entries = await blame(repo, null, 'café x.txt', 'zero\none\ntwo\nthree\n');
    expect(entries.map((entry) => entry.isUncommitted)).toEqual([true, false, false, false]);
    expect(entries[3].summary).toBe('add three');
  });
});

describe('locate', () => {
  it('gives a path inside the repo when reached through a symlink', async () => {
    expect(await locate(path.join(sandbox, 'link', 'sub dir'))).toEqual({ root: repo, relpath: 'sub dir' });
  });

  it('gives an empty path at the root', async () => {
    expect(await locate(repo)).toEqual({ root: repo, relpath: '' });
  });
});
