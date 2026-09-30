// The usage ladder: the set of mock readings every meter test drives.
//
// One list, two tiers. The e2e boots a real host per rung and asserts what came
// out; the unit tier pins the arithmetic behind the same rungs without a host.
// They cannot disagree about what "the ladder" is, which is the whole point of
// having it here rather than inlined in either test.
//
// The rungs are the ones a meter actually gets wrong. A single reading proves
// nothing about a layout that is rebuilt per value: the interesting cases are the
// extremes (0% and 100%, where there is no fill or no track at all), the
// threshold boundaries (80% for the warning color, 95% for the danger color), and
// any rung whose digits change the percent cell's width.

/**
 * @typedef {{
 *   name: string,
 *   plan: [number, number, number],
 *   share: number | null,
 *   severity: "muted" | "warning" | "error",
 *   why: string,
 * }} LadderRung
 */

/** Left-rotate `values` by `times`. */
export function rotate(values, times) {
  const shift = ((times % values.length) + values.length) % values.length;
  return [...values.slice(shift), ...values.slice(0, shift)];
}

// Uniform rungs: the extremes, the midpoint, and the two sides of the color
// ladder. The threshold constants live in `src/helpers.ts` (75 / 90); 80 and 95
// are one rung past each on purpose, so a threshold that drifts by a few points
// is still caught rather than landing exactly on the boundary.
const UNIFORM = [
  { value: 100, name: "all-full", severity: "error", why: "no track left to draw" },
  { value: 0, name: "all-empty", severity: "muted", why: "no fill at all" },
  { value: 50, name: "all-half", severity: "muted", why: "an even split" },
  { value: 80, name: "all-warning", severity: "warning", why: "past the warning threshold" },
  { value: 95, name: "all-danger", severity: "error", why: "past the danger threshold" },
];

// The mixed rung and its rotations. Four values, so four rotations: the share
// takes part, which is the point -- a block whose right edge moves when the share
// changes is the same defect as one whose edge moves when a plan window changes.
const MIXED_BASE = [0, 50, 90, 100];

/**
 * Every rung, in the order they should be run.
 *
 * @returns {LadderRung[]}
 */
export function usageLadders() {
  const uniform = UNIFORM.map(({ value, name, severity, why }) => ({
    name,
    plan: [value, value, value],
    share: value,
    severity,
    why,
  }));
  const mixed = MIXED_BASE.map((_, times) => {
    const [rolling, weekly, monthly, share] = rotate(MIXED_BASE, times);
    return {
      name: `mixed-rotation-${times}`,
      plan: [rolling, weekly, monthly],
      share,
      severity: "mixed",
      why: "the mixed distribution, rotated so every value lands in every column",
    };
  });
  return [...uniform, ...mixed];
}

// The severity a plan window's own percent should color by is NOT restated here.
// The thresholds live in `src/helpers.ts` (75 / 90) and the tests import
// `meterSeverityForPercent` from the built bundle, so the e2e's expectation about
// a mixed rung cannot drift from the ladder the plugin actually applies.

// `KILO_OC_GO_MOCK_PERCENTS` for a rung.
export const percentEnvValue = (plan) => plan.join(",");
// ---------------------------------------------------------------------------
// The resets-in ladder
// ---------------------------------------------------------------------------
//
// A countdown is the one piece of the block whose TEXT is chosen by a formatter
// rather than printed from the payload, so it is the one piece a single mock
// reading says nothing about. `1w 0d` and `1w` differ only in the formatter, and
// so do `1w 1d` and `1w 1d 22h`.
//
// Each rung sets all three windows at once, so three renderings are covered per
// boot instead of one, and each carries the text it expects so a failure names the
// formatting rule rather than just the numbers.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

/**
 * @typedef {{
 *   name: string,
 *   resets: string,
 *   limited: string,
 *   rows: Record<string, string | null>,
 *   statusline: string | null,
 *   why: string,
 * }} ResetRung
 */

/**
 * Every reset rung, in the order they should be run.
 *
 * @returns {ResetRung[]}
 */
export function resetLadders() {
  return [
    {
      name: "reset-exact-boundaries",
      resets: `${WEEK},${DAY},${8 * DAY + 22 * HOUR + 45 * MINUTE}`,
      limited: "1,1,1",
      // A countdown on exactly a week and on exactly a day is where the old
      // formatter printed its zero unit; the third is the case the extra unit
      // exists for.
      rows: { "5h": "1w", "7d": "1d", "30d": "1w 1d 22h" },
      // The longest cap outranks the shorter ones, so the header and the
      // statusline both name the 30d.
      statusline: "1w 1d 22h",
      why: "a countdown that lands exactly on a unit boundary",
    },
    {
      name: "reset-sub-day",
      resets: "45,300,7543",
      limited: "1,1,1",
      // Below a day nothing changed: the minutes and seconds are the finest
      // useful precision and the hours and minutes still run together.
      rows: { "5h": "45s", "7d": "5m", "30d": "2h5m" },
      statusline: "2h5m",
      why: "seconds and minutes, where the form is unchanged",
    },
    {
      name: "reset-days-and-hours",
      resets: `${6 * DAY + 22 * HOUR},${2 * DAY + 6 * HOUR},${30 * DAY}`,
      limited: "1,1,1",
      // Days and hours with no week in them, plus a 30-day window, which is the
      // case that gains nothing and must not invent a unit to fill the space.
      rows: { "5h": "6d 22h", "7d": "2d 6h", "30d": "4w 2d" },
      statusline: "4w 2d",
      why: "days with hours, and a 30-day window with no hour to add",
    },
    {
      name: "reset-uncapped",
      resets: "45,300,7543",
      // Nothing capped: the plan rows stay silent and only the statusline counts
      // down, which is the branch the plan rows never reach.
      limited: "0,0,0",
      rows: { "5h": null, "7d": null, "30d": null },
      // With no cap to outrank it, the soonest window is the answer.
      statusline: "45s",
      why: "countdowns with nothing capped, so only the statusline prints one",
    },
    {
      name: "reset-absent",
      resets: "-,-,-",
      limited: "0,0,0",
      rows: { "5h": null, "7d": null, "30d": null },
      statusline: null,
      why: "no countdown at all, so nothing may print one",
    },
  ];
}
