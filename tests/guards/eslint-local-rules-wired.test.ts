/**
 * The local ESLint plugin is REGISTERED and its rules are set to `error`.
 *
 * This exists because the rest of the rule's test suite cannot see the wiring.
 * `eslint-rules/__tests__/*.test.ts` drive the rule through ESLint's
 * `RuleTester`, importing the module directly — so deleting
 * `'local/no-fail-open-teardown-filter': 'error'` from `eslint.config.mjs`,
 * or softening it to `'off'` / `'warn'`, leaves every one of those tests green
 * AND leaves `npm run lint` green (it passes no `--max-warnings`). The sites
 * the rule protects stay fixed, so nothing else notices either.
 *
 * CLAUDE.md asks for a test that fails when the BEHAVIOUR regresses. For a lint
 * rule, "switched off" is the regression that costs everything and shows
 * nowhere, and it is invisible to the rule's own tests by construction.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const CONFIG = path.join(ROOT, 'eslint.config.mjs');

/** Rules the local plugin ships, each of which must be wired at `error`. */
const LOCAL_RULES = ['no-fail-open-teardown-filter'] as const;

describe('local ESLint rules are wired at error', () => {
    const config = fs.readFileSync(CONFIG, 'utf8');

    it('the config exists and registers a `local` plugin (positive control)', () => {
        // Without this, a renamed or deleted config would make every assertion
        // below vacuous — an absent file registers nothing.
        expect(config.length).toBeGreaterThan(500);
        expect(config).toMatch(/plugins:\s*\{/);
        expect(config).toMatch(/\blocal\b/);
    });

    it.each(LOCAL_RULES)('`local/%s` is set to error, not off or warn', (rule) => {
        const line = config
            .split('\n')
            .find((l) => l.includes(`local/${rule}`) && !l.trim().startsWith('//'));
        expect(line).toBeDefined();
        expect(line).toMatch(/'error'|"error"/);
        expect(line).not.toMatch(/'off'|"off"|'warn'|"warn"/);
    });

    it('every rule the plugin exports is wired here', () => {
        // The list above is hand-maintained, which makes it the denominator —
        // so compare it against what the plugin actually exports rather than
        // trusting it. A rule added to the plugin and not wired is a rule that
        // runs nowhere.
        const dir = path.join(ROOT, 'eslint-rules/rules');
        const exported = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.js'))
            .map((f) => f.replace(/\.js$/, ''))
            .sort();
        expect(exported.length).toBeGreaterThan(0);
        expect(exported).toEqual([...LOCAL_RULES].sort());
    });
});
