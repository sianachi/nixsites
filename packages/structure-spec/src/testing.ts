// Test-only fixtures: one valid, minimal argument set per WorkspaceOperation, and the reference
// flattener that turns one into the flat {operation, itemId, ...} shape. Kept off the package's main export surface - `@nix/structure-spec`
// - and reached instead through `@nix/structure-spec/testing`, so a production import never pulls
// in fixtures meant for tests and generators (`scripts/build-catalog.ts`, `@nix/companion`'s test
// suite, this package's own `tools.test.ts`).
export { EXAMPLE_ITEM_ID, flattenToolExample, TOOL_EXAMPLES } from './catalog/tool-examples.js';
