/**
 * An epic ratchet is deleted when its epic ships.
 *
 * WHY
 * ---
 * A ratchet named for one PR or epic — `b7-…`, `item-27-…`, `r14-…`,
 * `epic55-…`, `pr-b-…`, `roadmap-11-…` — does not encode an architectural
 * rule. It encodes the SHAPE OF ONE DIFF. Read the ones that were retired on
 * 2026-08-05 and the pattern is uniform: `readFileSync` the source, then
 * regex it for a literal that happened to be in that PR — a variable name
 * (`handleAssetRowClick`), a Tailwind class order
 * (`font-mono … text-xs … tabular-nums`), the interior spacing of an object
 * literal, a keyframe name in `tailwind.config.js`.
 *
 * Such a test cannot catch a regression the type system would miss: the code
 * it guards is imported and type-checked at its real call sites. What it CAN
 * do is fail when someone renames a variable, sorts classes, extracts a
 * shared helper, or reformats — all of which are refactors, not regressions.
 * So its true-positive rate is structurally zero and its false-positive rate
 * is proportional to how much you improve the code.
 *
 * That is not a neutral cost. 775 of 2,011 test files were ratchets, 29 of
 * them regexing `AssetsClient.tsx` alone. Extracting a shared helper meant
 * fixing dozens of source-string assertions, which made copy-paste the
 * cheaper option every single time. The suite was actively holding the
 * duplication in place.
 *
 * THE RULE
 * --------
 * Name a guard for the INVARIANT it protects, not for the work that
 * introduced it. `no-client-side-filtering`, `rls-coverage`,
 * `encryption-key-enforcement`, `api-permission-coverage` all still make
 * sense years after the PR that added them, and all still fail for a real
 * reason. `b7-asset-risk-tasks-column` never will.
 *
 * If what you want to enforce is structural — a banned import, a required
 * prop, a forbidden identifier, a naming convention — write an ESLint rule
 * instead. An AST rule survives reformatting and renaming; a regex over
 * source text does not.
 *
 * SURVIVORS
 * ---------
 * `ALLOWED` is the set that still carried a load when the retirement ran:
 * either another guard references it by name, or CLAUDE.md documents it as a
 * live platform rule. It is a shrinking list, not a budget to spend — adding
 * a name to it needs the same justification as adding a new guard, and
 * removing one is always welcome.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const GUARD_DIRS = ['tests/guards', 'tests/guardrails'];

/**
 * Filename prefixes that name a PR, batch, epic or roadmap item rather than
 * an invariant. Anchored at the start of the basename so a legitimate name
 * that merely contains one of these substrings is unaffected.
 */
const EPIC_NAME_PATTERNS: RegExp[] = [
    /^b\d+-/, // b1-… b9-…       batch N
    /^item-\d+/, // item-27-…       roadmap item N
    /^r\d+-/, // r13-… r31-…    roadmap N
    /^epic\d+/, // epic52-…        epic N
    /^pr-/, // pr-b-… pr-1-…   a single PR
    /^roadmap-\d+/, // roadmap-11-…    roadmap N
];

/**
 * Epic-named guards that survived the 2026-08-05 retirement, each with the
 * reason it could not simply be deleted. Shrink this list; do not grow it.
 */
const ALLOWED: Record<string, string> = {
    'b4-control-tasks-tab.test.ts': 'referenced by name from single-task-model.test.ts',
    'epic52-datatable-ratchet.test.ts':
        'CLAUDE.md documents it as the DataTable platform rule; referenced by behavioural-coverage-registry + interaction-state-discipline',
    'epic60-ratchet.test.ts':
        'CLAUDE.md documents it as the shared-hooks rule; referenced by no-explicit-any-ratchet',
    'r13-active-band-secondary.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r13-press-feedback.test.ts': 'referenced by name from motion-language-discipline.test.ts',
    'r14-mobile-parity-discipline.test.ts': 'referenced by name from mobile-roadmap-integrity.test.ts',
    'r14-no-page-searchbars.test.ts':
        'CLAUDE.md documents it as the search-placeholder rule (searchId + searchPlaceholder presence)',
    'r18-donut-bubble-entrance.test.ts': 'referenced by name from donut-chart-centering.test.ts',
    'r21-prb-sankey-rebuild.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r31-document-bar.test.ts': 'referenced by name from inline-subtitle-budget.test.ts',
};

function guardFiles(): string[] {
    const out: string[] = [];
    for (const dir of GUARD_DIRS) {
        const full = path.resolve(__dirname, '../../', dir);
        if (!fs.existsSync(full)) continue;
        for (const name of fs.readdirSync(full)) {
            if (name.endsWith('.test.ts')) out.push(name);
        }
    }
    return out;
}

function isEpicNamed(basename: string): boolean {
    return EPIC_NAME_PATTERNS.some((re) => re.test(basename));
}

describe('epic-named ratchets are not added back', () => {
    it('no new guard is named for a PR, batch, epic or roadmap item', () => {
        const offenders = guardFiles()
            .filter(isEpicNamed)
            .filter((f) => !(f in ALLOWED))
            .sort();

        // The message matters more than the assertion here — whoever trips
        // this is mid-PR and needs to know what to do instead.
        expect({
            offenders,
            hint:
                offenders.length === 0
                    ? 'none'
                    : 'Name the guard for the invariant it protects, not the work that introduced it. ' +
                      'If the rule is structural (banned import, required prop, forbidden identifier, ' +
                      'naming convention), write an ESLint rule instead — an AST rule survives ' +
                      'reformatting and renaming; a regex over source text does not.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('every allowlisted survivor still exists', () => {
        // A stale entry would quietly widen the allowlist for a future file
        // that happens to reuse the name.
        const present = new Set(guardFiles());
        const stale = Object.keys(ALLOWED)
            .filter((f) => !present.has(f))
            .sort();
        expect(stale).toEqual([]);
    });

    it('every allowlisted survivor carries a written reason', () => {
        const unexplained = Object.entries(ALLOWED)
            .filter(([, reason]) => reason.trim().length < 20)
            .map(([f]) => f)
            .sort();
        expect(unexplained).toEqual([]);
    });

    it('the retirement actually happened', () => {
        // Guards against a revert that restores the retired files without
        // anyone noticing this rule went quiet. 777 -> 624 on 2026-08-05;
        // the ceiling leaves room for legitimate new invariant-named guards
        // while catching a bulk restore.
        expect(guardFiles().length).toBeLessThan(700);
    });
});
