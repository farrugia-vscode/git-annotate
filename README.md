# Git Annotate

PHPStorm-style Git blame annotations for VS Code: toggle inline blame per file, annotate the previous revision, compare with a branch, and inspect commits — with an age heatmap.

## Features

- **Toggle blame** annotation per file (manual, PHPStorm-style — off by default)
- **Annotate previous revision** to walk back through history
- **Compare with branch…** from the explorer context menu
- **Show commit diff** and **copy revision hash** from the blame gutter
- Configurable template, date/author format, hash length, and age **heatmap**

## Usage

- **Git Blame: Toggle Annotation** (editor / line-number context menu)
- **Git Blame: Annotate Previous Revision**
- **Compare with Branch…** (explorer context menu)

See the extension settings (`gitAnnotate.*`) for formatting options.

## Install (local dev)

```bash
git clone git@github.com:farrugia-vscode/git-annotate.git ~/www/vscode-extensions/git-annotate
cd ~/www/vscode-extensions/git-annotate
bun install
bun run build   # compiles TS → out/extension.js
ln -s ~/www/vscode-extensions/git-annotate ~/.vscode/extensions/git-annotate
```

Reload VS Code. Dev loop: `bun run watch` (rebuild on change), `bun run check` (type-check).

## License

MIT
