// Resolve hook for the test runner. See ./env.ts for why.
//
// jsonc-parser's ESM entry re-exports from CommonJS, so a named import of it
// cannot be resolved statically under tsx. Redirect it to the CJS build, which
// tsx can load, and let the default interop produce the named export.

const CJS_BUILD = "jsonc-parser/lib/umd/main.js"

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "jsonc-parser" || specifier === "jsonc-parser/lib/esm/main.js") {
        return nextResolve(CJS_BUILD, context)
    }
    return nextResolve(specifier, context)
}
