// Test bootstrap: preload with `node --import ./tests/env.ts`.
//
// Registers a resolve hook for jsonc-parser. The package's ESM build re-exports
// from CommonJS, so `import { parse } from "jsonc-parser/lib/esm/main.js"`
// fails under tsx with "does not provide an export named 'parse'". The bundler
// works around this with noExternal; this is the same workaround for the test
// runner, and it is what lets a test import anything that reaches lib/config.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { register } from "node:module"
import { pathToFileURL } from "node:url"

register("./env-loader.mjs", pathToFileURL(join(import.meta.dirname, "env-loader.mjs")))

const root = mkdtempSync(join(tmpdir(), "dcp-test-"))
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || root
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || root
