// Preload for CLI scripts (`tsx --import ./scripts/stub-server-only.mjs`): `server-only` throws
// outside a React Server Component build, and the module code the seed and other scripts call
// imports it. Resolve it to an empty module for both the ESM and the CommonJS loader, the same
// stub vitest uses (DR-9). Never used by the Next.js app itself.
import Module, { register } from "node:module";

const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const STUB_ID = "\0beam-server-only-stub";
const original = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, ...rest) {
  if (request !== "server-only") return original.call(this, request, ...rest);
  if (!Module._cache[STUB_ID]) {
    const stub = new Module(STUB_ID);
    stub.loaded = true;
    stub.exports = {};
    Module._cache[STUB_ID] = stub;
  }
  return STUB_ID;
};
