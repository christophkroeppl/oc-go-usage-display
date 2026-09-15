// Disposable filesystem fixtures for the test suite.
//
// Every path is created with `mkdtemp` under `os.tmpdir()`. This module never
// references the real `os.homedir()` / `~/.config/opencode`: callers get an
// explicit, throwaway directory and are responsible for `cleanup()`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PREFIX = "oc-go-usage-display-test-";

// A generic throwaway directory.
export function makeTempDir(prefix = DEFAULT_PREFIX) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
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
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
