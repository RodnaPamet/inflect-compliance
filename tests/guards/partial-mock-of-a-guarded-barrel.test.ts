/**
 * Barrels that must not be mocked as a SUBSET, and a count that can only fall
 * (#2897).
 *
 * ═══ WHY A DECLARED LIST RATHER THAN EVERY BARREL ═══
 *
 * Measured across `tests/`: 934 factories partially mock a module with five or
 * more value exports. Almost all of them are correct — stubbing one function of
 * a 62-export barrel is the ordinary reason to reach for `jest.mock`. A ratchet
 * pinned to 934 would force churn through mostly-fine fixtures and teach people
 * to route around it.
 *
 * What makes a partial mock DANGEROUS is not its arithmetic, it is what the
 * omitted export does. So the population is declared, each entry with the
 * reason it earns a place, and it grows when a barrel demonstrates the failure
 * rather than when it crosses a threshold.
 *
 * Migrate an entry with `strictMock` (`tests/helpers/strict-mock.ts`), which
 * turns the omission into an error naming the module and the export, or by
 * spreading `requireActual` where the real implementation is genuinely wanted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    mockFactoriesIn,
    resolveAliasedModule,
    valueExportsOf,
} from '../helpers/mock-surface';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

interface GuardedBarrel {
    readonly reason: string;
    /** Current count. MAY FALL, NEVER RISE. */
    readonly cap: number;
}

const GUARDED_BARRELS: Readonly<Record<string, GuardedBarrel>> = {
    '@/lib/audit': {
        reason:
            're-exports `appendAuditEntryOrQueue`, the no-silent-drop wrapper (#2657). A factory ' +
            'supplying only `logEvent` resolves that wrapper to undefined, so the call that was ' +
            'supposed to guarantee an audit row silently does nothing and every assertion in the ' +
            'test still passes.',
        cap: 57,
    },
    '@/lib/permissions': {
        reason:
            'exports `permissionsForMembership`, which `initiatorAuthority` calls to resolve a ' +
            'custom role. Five suites supplied only `getPermissionsForRole`, so the moment a job ' +
            'path reached that resolution it died naming a function nobody had touched (#4397). ' +
            'Worse, a hand-rolled return value is role-INDEPENDENT: control-test-runner could drop ' +
            'its granular narrowing entirely and no test moved (#4388), so the argument was ' +
            'untestable as well as the omission unsafe.',
        // 1 on this branch, not 0: `control-test-runner.test.ts` is migrated by
        // #4401, which is not merged yet. Lower it to 0 in the same change that
        // rebases past #4401 -- two branches editing one ratchet line is how a
        // cap ends up above reality and stops being a ratchet.
        cap: 1,
    },
};

/** Test files that name the barrel at all — the only ones worth parsing. */
function testsMentioning(moduleId: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.test\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(moduleId)) {
                out.push(p);
            }
        }
    };
    walk(path.join(ROOT, 'tests'));
    return out;
}

function partialMocksOf(moduleId: string): string[] {
    const real = resolveAliasedModule(ROOT, moduleId);
    if (!real) throw new Error(`guarded barrel ${moduleId} does not resolve to repo source`);
    const exports = valueExportsOf(real);
    const offenders: string[] = [];
    for (const file of testsMentioning(moduleId)) {
        for (const f of mockFactoriesIn(file)) {
            if (f.moduleId !== moduleId) continue;
            if (f.defersToReal || f.keys === null) continue;
            const missing = [...exports].filter((k) => !f.keys!.has(k));
            if (missing.length > 0) offenders.push(path.relative(ROOT, file));
        }
    }
    return offenders;
}

/**
 * #3433 — a FILE that shadows a DIRECTORY barrel must forward all of it.
 *
 * `providers/github.ts` sits beside `providers/github/index.ts`. Node resolves
 * `./providers/github` to the FILE, so the directory barrel is unreachable
 * through that specifier and the file has to re-export everything the barrel
 * exports. `github.ts` says exactly that — "ALL exports must be forwarded
 * here" — and nothing enforced it, so adding `fetchBranchRules` to the barrel
 * produced `fetchBranchRules is not a function` in a suite that imports the
 * specifier, with a green `tsc` and a correct-looking barrel.
 *
 * Same failure mode as the partial mocks above: a barrel that is a SUBSET of
 * what callers expect, silently.
 */
describe('a file shadowing a directory barrel forwards every export', () => {
    /** Every `X.ts` in src that has a sibling `X/index.ts`. */
    const shadowingPairs = (): Array<{ shim: string; barrel: string }> => {
        const out: Array<{ shim: string; barrel: string }> = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (fs.existsSync(path.join(full, 'index.ts')) && fs.existsSync(`${full}.ts`)) {
                        out.push({ shim: `${full}.ts`, barrel: path.join(full, 'index.ts') });
                    }
                    walk(full);
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        return out;
    };

    it('finds the population it is about', () => {
        const pairs = shadowingPairs();
        // Positive control: an empty sweep would pass the next test vacuously.
        expect(pairs.length).toBeGreaterThanOrEqual(1);
        console.log(
            `#3433 — ${pairs.length} file(s) shadow a directory barrel: ` +
                pairs.map((x) => path.relative(ROOT, x.shim)).join(', '),
        );
    });

    it.each(shadowingPairs().map((x) => [path.relative(ROOT, x.shim), x]))(
        '%s forwards every value export of its barrel',
        (_label, pair) => {
            const { shim, barrel } = pair as { shim: string; barrel: string };
            const barrelExports = valueExportsOf(barrel);
            const shimExports = valueExportsOf(shim);
            expect(barrelExports.size).toBeGreaterThan(0);
            const missing = [...barrelExports].filter((n) => !shimExports.has(n)).sort();
            // Name them — the runtime error ("X is not a function") names the
            // symbol but not the reason, and the reason is this file.
            expect({ shim: path.relative(ROOT, shim), missing }).toEqual({
                shim: path.relative(ROOT, shim),
                missing: [],
            });
        },
    );
});

/**
 * #3433 — the production path must not rely on `evaluateBranchProtection`'s
 * default for its ruleset argument.
 *
 * The default is `[]`, so a caller that forgets the argument gets the classic
 * answer with no complaint — which is the defect this fixed. That default
 * exists for callers legitimately asking only the classic question; the real
 * check must always pass what it read, including `null` when the read failed.
 * tsc cannot see the difference between a deliberate omission and a forgotten
 * one, so it is checked here.
 */
describe('p2-github-passes-rulesets', () => {
    const PROVIDER = 'src/app-layer/integrations/providers/github/legacy-provider.ts';

    /**
     * MASKED AT THE READ SEAM — Class A. The question is what the CODE does,
     * and this file is full of prose about `evaluateBranchProtection(...)`
     * calls: a docblock quoting the call would otherwise satisfy the regex
     * below and the guard would grade its own comments.
     */
    const code = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

    it('every production call to evaluateBranchProtection passes rules explicitly', () => {
        const src = code(PROVIDER);
        const calls = [...src.matchAll(/evaluateBranchProtection\(([^)]*)\)/g)]
            // skip the declaration itself
            .filter((m) => !/^\s*$/.test(m[1]) && !m[1].includes(': '));
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const c of calls) {
            const args = c[1].split(',').map((a) => a.trim());
            expect(args.length).toBe(6);
            expect(args[5]).toBe('rules');
        }
    });

    it('and it reads the rulesets endpoint to have something to pass', () => {
        const src = code(PROVIDER);
        expect(src).toMatch(/await fetchBranchRules\(/);
        // The three-state contract: a failed read must stay distinguishable
        // from an empty one, or the fix regresses to the original defect.
        expect(src).toMatch(/const rulesetsUnread = rules === null;/);
    });
});

describe('a guarded barrel is not mocked as a subset', () => {
    it('the list is real: every entry resolves and is actually a barrel', () => {
        // A guarded module that does not resolve, or that exports almost
        // nothing, would make its ratchet vacuously satisfiable.
        expect(Object.keys(GUARDED_BARRELS).length).toBeGreaterThan(0);
        for (const id of Object.keys(GUARDED_BARRELS)) {
            const real = resolveAliasedModule(ROOT, id);
            expect(real).not.toBeNull();
            expect(valueExportsOf(real as string).size).toBeGreaterThanOrEqual(5);
        }
    });

    it('every entry states why it is guarded', () => {
        for (const [id, g] of Object.entries(GUARDED_BARRELS)) {
            expect(g.reason.length).toBeGreaterThan(60);
            expect(g.cap).toBeGreaterThanOrEqual(0);
            expect(id.startsWith('@/')).toBe(true);
        }
    });

    it('the scan can see the population it is counting', () => {
        // The denominator. Without it a broken parser reports zero offenders
        // and the ratchet passes by seeing nothing at all.
        for (const id of Object.keys(GUARDED_BARRELS)) {
            expect(testsMentioning(id).length).toBeGreaterThan(0);
        }
    });

    it.each(Object.keys(GUARDED_BARRELS))('%s stays at or below its cap', (id) => {
        const offenders = partialMocksOf(id);
        const { cap } = GUARDED_BARRELS[id];

        if (offenders.length > cap) {
            throw new Error(
                `${offenders.length} test files mock '${id}' as a subset; the cap is ${cap}. ` +
                    `${GUARDED_BARRELS[id].reason}\n` +
                    `Use strictMock (tests/helpers/strict-mock.ts) or spread requireActual.\n` +
                    `Newest offenders:\n  ${offenders.slice(0, 5).join('\n  ')}`,
            );
        }
        expect(offenders.length).toBeLessThanOrEqual(cap);
    });

    it('the cap tracks reality, so a migration lowers it', () => {
        // A cap far above the real count is a ratchet that has stopped
        // ratcheting: it would absorb new offenders silently. Kept within
        // five so the next migration has to move the number.
        for (const id of Object.keys(GUARDED_BARRELS)) {
            const actual = partialMocksOf(id).length;
            expect(GUARDED_BARRELS[id].cap - actual).toBeLessThanOrEqual(5);
        }
    });
});
