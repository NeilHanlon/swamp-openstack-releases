/**
 * A faithful port of RPM's `rpmvercmp` (lib/rpmvercmp.c) plus EVR comparison.
 *
 * Pure, no I/O — the single source of truth for "which version is newer" across
 * the Epoxy inventory pipeline: `openstack_releases` picks each deliverable's
 * `latestVersion` with it, and `epoxy_gap` decides current/behind/ahead with it.
 * Do NOT shell out to `rpmdev-vercmp`; do NOT re-implement it anywhere else.
 *
 * Segment semantics match RPM exactly, including the two easy-to-get-wrong
 * separators:
 *  - `~` (tilde) sorts *before* everything, even the empty string, so
 *    `1.0~rc1` < `1.0` — OpenStack uses these heavily for pre-releases.
 *  - `^` (caret) sorts *after* the base version, so `1.0^git0` > `1.0`.
 *
 * @module
 */

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string): boolean => isDigit(c) || isAlpha(c);

/**
 * Compare two RPM version (or release) strings.
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 */
export function rpmvercmp(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;

  let i = 0;
  let j = 0;
  const na = a.length;
  const nb = b.length;

  while (i < na || j < nb) {
    // Skip separator runs (anything that isn't alphanumeric, ~, or ^).
    while (i < na && !isAlnum(a[i]) && a[i] !== "~" && a[i] !== "^") i++;
    while (j < nb && !isAlnum(b[j]) && b[j] !== "~" && b[j] !== "^") j++;

    // Tilde sorts before everything, including the empty string.
    const at = i < na && a[i] === "~";
    const bt = j < nb && b[j] === "~";
    if (at || bt) {
      if (!at) return 1;
      if (!bt) return -1;
      i++;
      j++;
      continue;
    }

    // Caret: like tilde, but if one string has ended the base is the higher.
    const ac = i < na && a[i] === "^";
    const bc = j < nb && b[j] === "^";
    if (ac || bc) {
      if (i >= na) return -1;
      if (j >= nb) return 1;
      if (!ac) return 1;
      if (!bc) return -1;
      i++;
      j++;
      continue;
    }

    // If either ran out here, the loop is done.
    if (i >= na || j >= nb) break;

    // Grab the next completely-numeric or completely-alpha segment. The type
    // is decided by `a`'s current char; `b` grabs the same kind.
    const startI = i;
    const startJ = j;
    let isnum: boolean;
    if (isDigit(a[i])) {
      while (i < na && isDigit(a[i])) i++;
      while (j < nb && isDigit(b[j])) j++;
      isnum = true;
    } else {
      while (i < na && isAlpha(a[i])) i++;
      while (j < nb && isAlpha(b[j])) j++;
      isnum = false;
    }

    let segA = a.slice(startI, i);
    let segB = b.slice(startJ, j);

    // Different segment types: numeric always beats alpha (empty) segment.
    if (segA.length === 0) return -1; // defensive; `a`'s type drove the grab
    if (segB.length === 0) return isnum ? 1 : -1;

    if (isnum) {
      // Numbers: drop leading zeros, then more digits (or higher) wins.
      segA = segA.replace(/^0+/, "");
      segB = segB.replace(/^0+/, "");
      if (segA.length > segB.length) return 1;
      if (segB.length > segA.length) return -1;
    }

    if (segA < segB) return -1;
    if (segA > segB) return 1;
    // Equal segment — keep going.
  }

  if (i >= na && j >= nb) return 0;
  return i >= na ? -1 : 1;
}

/** An epoch/version/release triple; epoch and release may be absent. */
export interface EVR {
  epoch?: string | number | null;
  version: string;
  release?: string | null;
}

const epochOf = (e: string | number | null | undefined): number => {
  if (e === null || e === undefined || e === "") return 0;
  const n = parseInt(String(e), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Full EVR compare: epoch dominates (absent == 0), then version, then release.
 * A release is only compared when both sides carry one (RPM semantics).
 */
export function evrCompare(a: EVR, b: EVR): -1 | 0 | 1 {
  const ea = epochOf(a.epoch);
  const eb = epochOf(b.epoch);
  if (ea !== eb) return ea < eb ? -1 : 1;

  const vc = rpmvercmp(a.version, b.version);
  if (vc !== 0) return vc;

  if (!a.release || !b.release) return 0;
  return rpmvercmp(a.release, b.release);
}
