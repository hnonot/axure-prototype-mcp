/**
 * The in-page calling convention.
 *
 * The adapter compiles a function declaration inside Chromium and then calls a fixed name on it.
 * That name is defined here, once, so the two halves cannot drift apart: the adapter imports
 * this constant to build its `return <name>;`, and every in-page declaration is named to match.
 *
 * This exists because the name was briefly duplicated in two places, and a mismatch fails only
 * at run time *inside the browser* with `ReferenceError: axureExtractOutline is not defined` —
 * a failure mode that is invisible to the type checker and easy to reintroduce.
 *
 * `scripts/test-inpage.mjs` asserts that every in-page declaration uses this name.
 */
export const INPAGE_FACTORY_NAME = 'axureExtractOutline';
