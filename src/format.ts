// Pure formatting + color helpers — no vscode dependency, unit-testable headless.
import type { BlameEntry, Config } from './types';

export function formatAuthor(author: string | undefined, mode: string): string {
  const name = (author || 'Unknown').trim();
  const parts = name.split(/\s+/);
  if (mode === 'first') {
    return parts[0];
  }
  if (mode === 'last') {
    return parts[parts.length - 1];
  }
  if (mode === 'initials') {
    return parts.map((part) => part[0]).join('').toUpperCase();
  }
  return name;
}

function relativeDate(epochSec: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epochSec);
  const day = 86400;
  if (seconds < day) {
    return 'today';
  }
  if (seconds < 30 * day) {
    return `${Math.floor(seconds / day)}d`;
  }
  if (seconds < 365 * day) {
    return `${Math.floor(seconds / (30 * day))}mo`;
  }
  return `${Math.floor(seconds / (365 * day))}y`;
}

export function formatDate(epochSec: number, mode: string): string {
  const date = new Date(epochSec * 1000);
  const two = (value: number) => String(value).padStart(2, '0');
  if (mode === 'short') {
    return `${two(date.getMonth() + 1)}/${two(date.getDate())}`;
  }
  if (mode === 'relative') {
    return relativeDate(epochSec);
  }
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function renderLineText(entry: BlameEntry, config: Config): string {
  if (entry.isUncommitted) {
    return 'Uncommitted';
  }
  const tokens: Record<string, string> = {
    hash: entry.hash.slice(0, config.hashLength),
    date: formatDate(entry.authorTime ?? 0, config.dateFormat),
    author: formatAuthor(entry.author, config.authorFormat),
    email: entry.email || '',
    summary: entry.summary || '',
  };
  return config.template
    .replace(/\$\{(\w+)\}/g, (_match, key: string) => (key in tokens ? tokens[key] : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) {
    return [0, 0, lightness];
  }
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === r) {
    hue = (g - b) / delta + (g < b ? 6 : 0);
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return [(hue / 6) * 360, saturation, lightness];
}

function hslToHex(h: number, s: number, l: number): string {
  h /= 360;
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) {
      t += 1;
    }
    if (t > 1) {
      t -= 1;
    }
    if (t < 1 / 6) {
      return p + (q - p) * 6 * t;
    }
    if (t < 1 / 2) {
      return q;
    }
    if (t < 2 / 3) {
      return p + (q - p) * (2 / 3 - t) * 6;
    }
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (channel: number) => Math.round(channel * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ratio 0 = oldColor (oldest commit), 1 = newColor (newest). Only the hue/saturation of the
// configured colors carry the age signal; lightness is pinned to the theme so the text always
// keeps a readable contrast against the (theme-adaptive) gutter background.
export function heatColor(ratio: number, oldColor: string, newColor: string, isDark: boolean): string {
  const from = rgbToHsl(...(hexToRgb(oldColor) ?? [241, 76, 76]));
  const to = rgbToHsl(...(hexToRgb(newColor) ?? [78, 201, 78]));
  const clamped = Math.min(1, Math.max(0, ratio));
  const lerp = (a: number, b: number) => a + (b - a) * clamped;
  const saturation = Math.max(0.5, lerp(from[1], to[1]));
  const lightness = isDark ? 0.66 : 0.4;
  return hslToHex(lerp(from[0], to[0]), saturation, lightness);
}
