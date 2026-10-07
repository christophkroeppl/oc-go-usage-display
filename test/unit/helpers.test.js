// Unit tier: `dist/helpers.js` pure predicates.
//
// Requires a prior `bun run build`: this tier imports the compiled dist/*.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRenderModelsHeader } from "../../dist/helpers.js";

describe("shouldRenderModelsHeader", () => {
  it("returns false for an empty models array", () => {
    expect(shouldRenderModelsHeader([])).toBe(false);
  });

  it("returns true when at least one model exists", () => {
    expect(shouldRenderModelsHeader([{ modelID: "test" }])).toBe(true);
  });
});
