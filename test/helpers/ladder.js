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