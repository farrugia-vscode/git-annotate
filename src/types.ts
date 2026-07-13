export interface BlameEntry {
  hash: string;
  isUncommitted: boolean;
  author?: string;
  email?: string;
  authorTime?: number;
  summary?: string;
  previousHash?: string;
  previousPath?: string;
}

export interface NameStatusEntry {
  status: string;
  oldPath?: string;
  newPath?: string;
}

export interface RevisionTarget {
  root: string;
  rev: string | null;
  relpath: string;
}

export interface Config {
  template: string;
  hashLength: number;
  dateFormat: string;
  authorFormat: string;
  heatmap: boolean;
  oldColor: string;
  newColor: string;
  maxWidth: number;
  autoAnnotate: boolean;
}
