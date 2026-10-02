// A color-aware reader for a tmux pane.
//
// The display e2e asserts the plain pane, because a plain capture can see the
// GRID the meters sit in but not the meters themselves -- they are
// background-colored boxes, which arrive as spaces. That is enough to pin
// alignment, and it is not enough to pin COLOR: `capture-pane -e` keeps the SGR
// sequences, so every cell also carries the background the host actually painted
// it with. That is the only way to assert "80% is the warning color and 95% is
// the danger color" against a real host instead of against the thresholds the
// plugin believes it is using.
//
// Everything here is a pure function over the captured string, so the unit tier
// can pin the decoder against a literal ANSI fixture without a tmux, a host or a
// terminal.

// tmux writes SGR runs in the usual `\x1b[<params>m` form. Params may be empty
// (`\x1b[m` == reset) and are colon-separated in some hosts, so both are accepted.
const SGR = /\x1b\[([0-9;:]*)([a-zA-Z])/g;

/**
 * One decoded cell. `fg`/`bg` are normalized descriptors ("rgb:1,2,3",
 * "idx:208", "c5") or `null` for "the terminal default", which is the only value
 * that means "no background painted here".
 *
 * @typedef {{ ch: string, fg: string | null, bg: string | null }} PaneCell
 * @typedef {{ col: number, bg: string | null, len: number }} BgRun
 */

const ANSI_256 = (n) => `idx:${n}`;

function applySgr(state, params) {
  // An empty parameter list is a full reset, and so is an explicit 0. Both must
  // clear BOTH attributes: tmux emits `\x1b[0m` between styled runs and any
  // leftover background would bleed into the next cell.
  const raw = params === "" ? ["0"] : params.split(/[;:]/);
  const next = { ...state };
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "" || raw[i] === undefined) continue;
    const code = Number(raw[i]);
    if (Number.isNaN(code)) continue;
    if (code === 0) { next.fg = null; next.bg = null; continue; }
    if (code === 39) { next.fg = null; continue; }
    if (code === 49) { next.bg = null; continue; }
    // 30-37 / 90-97 foreground, 40-47 / 100-107 background: the 16 ANSI colors.
    if (code >= 30 && code <= 37) { next.fg = `c${code - 30}`; continue; }
    if (code >= 90 && code <= 97) { next.fg = `c${code - 90 + 8}`; continue; }
    if (code >= 40 && code <= 47) { next.bg = `c${code - 40}`; continue; }
    if (code >= 100 && code <= 107) { next.bg = `c${code - 100 + 8}`; continue; }
    // Extended colors: 38/48 with either a 256-color index or truecolor RGB.
    if (code === 38 || code === 48) {
      const kind = Number(raw[i + 1]);
      if (kind === 5) { const v = ANSI_256(raw[i + 2]); if (code === 38) next.fg = v; else next.bg = v; i += 2; continue; }
      if (kind === 2) {
        const v = `rgb:${raw[i + 2]},${raw[i + 3]},${raw[i + 4]}`;
        if (code === 38) next.fg = v; else next.bg = v;
        i += 4;
        continue;
      }
    }
  }
  return next;
}

// Decode an SGR-annotated pane into rows of cells. A bare `\r` is treated as a
// column reset rather than a cell, and a trailing row is always emitted so the
// last line of the pane is not dropped.
export function decodePane(ansi) {
  const rows = [];
  let row = [];
  let state = { fg: null, bg: null };
  let cursor = 0;
  SGR.lastIndex = 0;
  let match;
  while ((match = SGR.exec(ansi)) !== null) {
    for (const ch of ansi.slice(cursor, match.index)) {
      if (ch === "\n") { rows.push(row); row = []; }
      else if (ch !== "\r") row.push({ ch, fg: state.fg, bg: state.bg });
    }
    // Only SGR (`m`) carries styling; a stray CSI of another kind is skipped
    // without changing state so a host that emits one cannot desync the colors.
    if (match[2] === "m") state = applySgr(state, match[1]);
    cursor = SGR.lastIndex;
  }
  for (const ch of ansi.slice(cursor)) {
    if (ch === "\n") { rows.push(row); row = []; }
    else if (ch !== "\r") row.push({ ch, fg: state.fg, bg: state.bg });
  }
  rows.push(row);
  return rows;
}

export const rowText = (row) => row.map((cell) => cell.ch).join("");

// Run-length encode one attribute along a row, so a meter's geometry is readable
// as "11 cells of fill, 16 of track" instead of a 200-column string.
//
// @param {PaneCell[]} row
// @returns {BgRun[]}
export function bgRuns(row) {
  const runs = [];
  row.forEach((cell, col) => {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.bg === cell.bg) last.len += 1;
    else runs.push({ col, bg: cell.bg, len: 1 });
  });
  return runs;
}

// Only runs wide enough to be part of a meter body. A one-cell run is a glyph
// that happens to sit on a background, not a bar.
export const isMeterRun = (run, minCells = 4) => run.bg !== null && run.len >= minCells;

// The rows that carry a meter, by the label the plugin prints. Exported so the
// helper and the assertions cannot disagree about which rows are ours -- the host
// draws plenty of its own right-aligned rows in the same sidebar.
export const METER_LABELS = ["5h", "7d", "30d", "Go share"];

/**
 * The meter's geometry on one row, or null when the row carries no meter.
 *
 * A meter is a filled box and a track, both painted backgrounds, so its extent is
 * found from the SURROUNDINGS rather than from the colors themselves: the
 * percent cell sits on the sidebar's own background, the label cell does too, and
 * the meter is the one unbroken span between them that is neither. That is what
 * makes this work at every rung -- at 100% there is no track and the fill runs to
 * the percent cell; at 0% there is no fill and the track runs from the label to
 * the percent cell. Both are found by the same two walks.
 *
 * @param {PaneCell[]} row
 */
export function meterGeometry(row) {
  const percent = trailingPercent(row);
  if (percent === null) return null;
  const text = rowText(row).replace(/\s+$/, "");
  const label = METER_LABELS.find((candidate) => text.trimStart().startsWith(candidate));
  if (label === undefined) return null;
  // The sidebar background, taken from the percent cell itself: it is the tone
  // the block is drawn on, so "not the panel" is the definition of "the meter".
  const panelBg = row[percent.endCol - 1]?.bg ?? null;
  // Left of the percent is its own leading pad, painted as the panel. The walk is
  // by BACKGROUND only: a meter's own cells are spaces, so a whitespace test here
  // would eat the track and stop at the label.
  let end = percent.startCol;
  while (end > 0 && row[end - 1].bg === panelBg) end -= 1;
  // Then the meter, which is every cell back to the label's own padding.
  let start = end;
  while (start > 0 && row[start - 1].bg !== panelBg) start -= 1;
  const span = row.slice(start, end);
  return {
    label,
    percent: percent.percent,
    // Where the percent's own right edge sits. THE invariant: it must be the same
    // column on every rung, which is what a user reads as "the numbers line up".
    percentEndCol: percent.endCol,
    percentStartCol: percent.startCol,
    startCol: start,
    endCol: end,
    width: end - start,
    runs: bgRuns(span),
    row,
  };
}

// The percent a row shows, or null when it shows none.
//
// Anchored to the last `\d+%` on the row rather than to its final character,
// because the host's sidebar draws its own edge down the right of every line --
// a border, a scrollbar thumb, a resize grip -- and those glyphs sit after our
// percent. Requiring the percent to be the row's last text, and treating
// everything after it as the host's furniture, is what keeps a host in a
// different panel state from looking like our row went missing.
export function trailingPercent(row) {
  const text = rowText(row);
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)%/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const after = text.slice(last.index + last[0].length);
  if (!/^[\s─-╿■-◿]*$/.test(after)) return null;
  const endCol = last.index + last[0].length;
  return { percent: Number(last[1]), startCol: last.index, endCol };
}

/**
 * Every metered row in a decoded pane, in render order.
 *
 * @param {PaneCell[][]} rows
 */
export function meterRows(rows) {
  return rows.map((row) => meterGeometry(row)).filter((meter) => meter !== null);
}

/**
 * How a meter's cells divide between `fillBg` and everything else.
 *
 * Counting cells rather than reading the runs is deliberate: it makes the
 * assertion "this many cells are the accent color and the rest are surface",
 * which holds at 0% (no accent cells) and at 100% (no surface cells) without
 * needing to know which end is which first.
 *
 * @param {{ runs: BgRun[], width: number }} meter
 * @param {string} fillBg
 */
export function splitMeter(meter, fillBg) {
  const fill = meter.runs.filter((run) => run.bg === fillBg).reduce((sum, run) => sum + run.len, 0);
  const track = meter.width - fill;
  return { fill, track, fillRuns: meter.runs.filter((run) => run.bg === fillBg).length };
}