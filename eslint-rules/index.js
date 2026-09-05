'use strict';

/**
 * `eslint-plugin-local` — this repo's own ESLint rules.
 *
 * CLAUDE.md's guard policy says: "If the rule is structural — a banned
 * import, a required prop, a forbidden identifier, a naming convention —
 * write an ESLint rule instead. An AST rule survives reformatting and
 * renaming; a regex over source text does not." Until now the repo had
 * nowhere to put one, so the policy was unfollowable and every structural
 * rule landed as another `readFileSync` + regex under `tests/guards/`.
 * This directory is that somewhere.
 *
 * ── Module format: CommonJS `.js`, and it is not a free choice ───────
 *
 * `package.json` declares no `"type"`, so a `.js` file here is CommonJS.
 * All three consumers can load it:
 *
 *   - `eslint.config.mjs` (ESM) imports it — Node's CJS/ESM interop gives
 *     the module object as the default export.
 *   - Jest's `node` project (CommonJS, ts-jest) requires it, so the rules
 *     can be exercised with ESLint's own `RuleTester` from a `.ts` test.
 *   - Editors and `eslint .` load it the same way.
 *
 * The two alternatives were both measured and both fail:
 *
 *   `.mjs` — TypeScript treats a `.mjs` file as ES-module format
 *     unconditionally and will not downlevel it to CommonJS, so ts-jest
 *     hands Jest untransformed `export` syntax and every rule test dies
 *     with `SyntaxError: Unexpected token 'export'`. The rules would be
 *     unreachable from the test runner — which is the whole point of
 *     having them here.
 *
 *   `.cjs` — `eslint.config.mjs` applies the `react-hooks/*` rules to all
 *     files, but `eslint-config-next` only registers the `react-hooks`
 *     plugin for its own scope, which excludes `.cjs`. The Lint job then
 *     fails with "could not find plugin react-hooks". Known repo trap; the
 *     same reason every build script under `scripts/` is `.js` or `.mjs`.
 *
 * ── Adding a rule ────────────────────────────────────────────────────
 *
 * See ./README.md. Short version: drop it in `rules/`, register it below,
 * add a `RuleTester` test under `__tests__/` with BOTH valid and invalid
 * cases, and turn it on in `eslint.config.mjs`.
 */

const noFailOpenTeardownFilter = require('./rules/no-fail-open-teardown-filter');

module.exports = {
    meta: {
        name: 'eslint-plugin-local',
        version: '1.0.0',
    },
    rules: {
        'no-request-derived-public-url': require('./rules/no-request-derived-public-url'),
        'no-fail-open-teardown-filter': noFailOpenTeardownFilter,
        'require-agent-attribution': require('./rules/require-agent-attribution'),
        'require-mcp-tool-authorization': require('./rules/require-mcp-tool-authorization'),
        'no-raw-prompt-logging': require('./rules/no-raw-prompt-logging'),
    },
};
