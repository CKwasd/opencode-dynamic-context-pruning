import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Preload via `node --import ./tests/env.ts`. Without it, tests that write
// session state land in the real ~/.local/share/opencode/storage/plugin/dcp
// because they never redirect XDG_DATA_HOME. Individual tests may still point
// these at their own fixture directory; this only guarantees a default.
const root = mkdtempSync(join(tmpdir(), "dcp-test-"))
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || root
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || root
