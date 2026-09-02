// Small fs / logging helpers shared across pipeline steps.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function ensureParent(file) {
  ensureDir(dirname(file));
}

export function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJSON(file, obj, { pretty = false } = {}) {
  ensureParent(file);
  writeFileSync(file, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
}

export function exists(p) {
  return existsSync(p);
}

export function rmrf(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

const t0 = Date.now();
export function log(...args) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${secs}s]`, ...args);
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
