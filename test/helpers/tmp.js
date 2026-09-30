// Disposable filesystem fixtures for the test suite.
//
// Every path is created with `mkdtemp` under `os.tmpdir()`. This module never
// references the real `os.homedir()` / `~/.config/opencode`: callers get an
// explicit, throwaway directory and are responsible for `cleanup()`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PREFIX = "oc-go-usage-display-test-";

// Remove a throwaway root, tolerating a child that is still shutting down.
//
// The TUI tests kill a real host and return immediately, and the host can still be
// writing a cache under `$XDG_CACHE_HOME` (a compiled-module cache on some
// installs) while the root is being removed. `fs.rmSync` reports ENOTEMPTY for
// that, which fails the test for a reason that has nothing to do with what the
// test asserted -- and the leftovers are in `os.tmpdir()` either way. So the
// removal is retried briefly, and a still-failing root is left behind rather than
// masking the test's real result.
function removeTree(dir, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt >= attempts || error?.code !== "ENOTEMPTY") {
        console.error(`[test] could not remove ${dir}: ${error?.message ?? error}`);
        return;
      }
    }
  }
}

// A generic throwaway directory.
export function makeTempDir(prefix = DEFAULT_PREFIX) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      removeTree(dir);
    },
  };
}

// A throwaway opencode layout: `<root>/config` is the opencode config dir and
// `<root>/home` is an isolated HOME. `configDir` is deliberately `<root>/config`
// so it matches the default `OPENCODE_CONFIG_DIR` built by `test/helpers/run.js`.
export function makeConfigDir(prefix = DEFAULT_PREFIX) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return {
    root,
    home,
    configDir,
    cleanup() {
      removeTree(root);
    },
  };
}
