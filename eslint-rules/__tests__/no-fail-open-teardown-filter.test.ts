/**
 * `local/no-fail-open-teardown-filter` — behavioural tests.
 *
 * Run through ESLint's own `RuleTester`, so these exercise the rule the
 * way ESLint will: real parse, real scope analysis, real reports.
 *
 * The `valid` half is the load-bearing half. An invalid-only suite passes
 * against a rule that flags EVERYTHING, which is the failure mode a
 * fail-closed rule is most likely to have — so every narrowing decision
 * the rule makes (const is safe, an initialised `let` is safe, an array
 * literal is safe, a non-teardown hook is out of scope, the `if` guard
 * works) gets a `valid` case that would go red if the narrowing broke.
 *
 * Cases are written in TypeScript and parsed with `@typescript-eslint/parser`
 * because the code this rule polices is `tests/integration/**.ts` — a
 * default-parser suite would prove the rule works on syntax it will never
 * actually see (`let tenantA: string;` alone is a parse error under espree).
 *
 * That parser is reached through the repo-wide `overrides` pin in
 * package.json rather than a direct devDependency, deliberately: adding
 * `@typescript-eslint/parser` to `devDependencies` at the same literal range
 * the override already carries is the shape that aborts a whole Dependabot
 * run (the `"$name"` idiom exists to avoid it), and it would mean
 * regenerating package-lock.json. The first `it` below asserts the parser is
 * really in play, so if the tree ever stops providing it the failure says so
 * instead of surfacing as two dozen "Unexpected token :" parse errors.
 */
import { Linter, RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

import rule from '../rules/no-fail-open-teardown-filter';

const ruleTester = new RuleTester({
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
    },
});

/** The single message this rule emits. */
const failOpen = { messageId: 'failOpenFilter' };

describe('local/no-fail-open-teardown-filter', () => {
    it('runs its cases through the TypeScript parser, not espree', () => {
        expect(typeof tsParser.parseForESLint).toBe('function');
        // The positive companion. `let x: string;` is a parse error under
        // the default parser, so this succeeding is evidence the TS parser
        // is the one doing the work — an assertion that the parser object
        // merely EXISTS would pass even if RuleTester ignored it.
        expect(() => tsParser.parse('let tenantA: string;')).not.toThrow();
    });

    // NOT wrapped in an `it(...)`. ESLint 9's RuleTester detects the host
    // test framework and emits its own `describe` / `it` per case, so
    // nesting it inside a test fails with "Tests cannot be nested" — and
    // the per-case names below would be lost.
    ruleTester.run('no-fail-open-teardown-filter', rule, {
        valid: [
            // ── The repo's fix idiom, verbatim from #2113 ──────────
            // If this went red the rule would be unusable: the
            // documented remedy would still be a violation.
            {
                name: 'guarded by an enclosing if',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (tenantA) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
            },
            {
                name: 'guarded by a multi-variable if',
                code: `
                    let tenantA: string;
                    let tenantB: string;
                    afterAll(async () => {
                        if (tenantA && tenantB) {
                            await prisma.risk.deleteMany({
                                where: { OR: { a: tenantA, b: tenantB } },
                            });
                        }
                    });
                `,
            },
            {
                name: 'guarded by a logical && expression',
                code: `
                    let userId: string;
                    afterAll(async () => {
                        userId && (await prisma.user.deleteMany({ where: { id: userId } }));
                    });
                `,
            },

            // ── Bindings that cannot be undefined at teardown ──────
            {
                name: 'a const fixture id needs no guard',
                code: `
                    const TENANT_ID = 'fixed-id';
                    afterAll(async () => {
                        await prisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
                    });
                `,
            },
            {
                name: 'a let WITH an initializer needs no guard',
                code: `
                    let slug = 'seed-slug';
                    afterAll(async () => {
                        await prisma.tenant.deleteMany({ where: { slug } });
                    });
                `,
            },
            {
                name: 'a function parameter is not a bare let',
                code: `
                    function cleanup(tenantId: string) {
                        afterAll(async () => {
                            await prisma.risk.deleteMany({ where: { tenantId } });
                        });
                    }
                `,
            },

            // ── Shapes Prisma already rejects ─────────────────────
            {
                name: 'an array literal is validated by Prisma and throws on undefined',
                code: `
                    let tenantA: string;
                    let tenantB: string;
                    afterAll(async () => {
                        await prisma.tenant.deleteMany({
                            where: { id: { in: [tenantA, tenantB] } },
                        });
                    });
                `,
            },

            // ── Out of scope ──────────────────────────────────────
            {
                name: 'a deleteMany in beforeAll is setup, not teardown',
                code: `
                    let tenantA: string;
                    beforeAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                    });
                `,
            },
            {
                name: 'a bounded delete (not deleteMany) is out of scope',
                code: `
                    let riskId: string;
                    afterAll(async () => {
                        await prisma.risk.delete({ where: { id: riskId } });
                    });
                `,
            },
            {
                name: 'a deleteMany with no where clause is a different problem',
                code: `
                    afterAll(async () => {
                        await prisma.risk.deleteMany({});
                    });
                `,
            },
            {
                name: 'a literal filter value is never undefined',
                code: `
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: 'literal' } });
                    });
                `,
            },
            {
                name: 'a shadowing const inside the hook wins over the outer bare let',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        const tenantA = resolveTenant();
                        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                    });
                `,
            },
            {
                name: 'scalar array member stays safe — Prisma rejects undefined IN an array',
                code: `
                    let tenantA: string;
                    let tenantB: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
                    });
                `,
            },
            {
                name: 'explicit non-nullish guard is a real guard',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (tenantA !== undefined) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
            },
            {
                name: 'loose non-null guard is a real guard',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (tenantA != null) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
            },
            {
                name: 'conjunction — every operand must hold, so an && operand guards',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (someFlag && tenantA) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
            },
        ],

        invalid: [
            // ── The two fail-OPEN shapes the first version was silent on,
            //    both measured against the real client at 331 rows.
            {
                name: 'AND combinator — { AND: [{ id: undefined }] } matches EVERY row',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { AND: [{ tenantId: tenantA }] } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'NOT combinator — same, and the array skip used to cover it',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { NOT: [{ tenantId: tenantA }] } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'where: <bare let> — the whole filter object is the variable',
                code: `
                    let filter: object;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: filter });
                    });
                `,
                errors: [failOpen],
            },
            // ── POLARITY. The first version of this rule accepted any test
            //    that MENTIONED the variable, so all three of these were
            //    silent. The first is strictly WORSE than no guard at all.
            {
                name: 'negated guard — the delete runs exactly when the filter is undefined',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (!tenantA) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'equality-to-undefined guard is the inverse of a guard',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (tenantA === undefined) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'disjunction — the branch can run with the variable falsy',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (someFlag || tenantA === null) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
                errors: [failOpen],
            },
            // ── The #2113 defect, exactly as it stood on main ──────
            {
                name: 'bare let read as a scalar filter in afterAll',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        try {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        } catch {}
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'shorthand property form',
                code: `
                    let tenantId: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'afterEach hook',
                code: `
                    let userId: string;
                    afterEach(async () => {
                        await prisma.user.deleteMany({ where: { id: userId } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'updateMany drops the predicate the same way deleteMany does',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        await prisma.risk.updateMany({
                            where: { tenantId: tenantA },
                            data: { archived: true },
                        });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'nested relation filter',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        await prisma.finding.deleteMany({
                            where: { tenant: { id: tenantA } },
                        });
                    });
                `,
                errors: [failOpen],
            },
            {
                // The trap #2114 wrote down and left unfixed because no
                // live instance existed: two of three `in` shapes are
                // safe and the third is not.
                name: 'an identifier standing for the whole `in` array fails open like a scalar',
                code: `
                    let tenantIds: string[];
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: { in: tenantIds } } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'var, not just let',
                code: `
                    var tenantA: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                    });
                `,
                errors: [failOpen],
            },
            {
                name: 'Playwright test.afterAll is a teardown hook too',
                code: `
                    let tenantA: string;
                    test.afterAll(async () => {
                        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                    });
                `,
                errors: [failOpen],
            },
            {
                // Two bare lets, one report each — the de-dupe is
                // per-variable, not per-call.
                name: 'two unguarded bare lets in one filter report twice',
                code: `
                    let tenantA: string;
                    let ownerId: string;
                    afterAll(async () => {
                        await prisma.risk.deleteMany({
                            where: { tenantId: tenantA, ownerId },
                        });
                    });
                `,
                errors: [failOpen, failOpen],
            },
            {
                // A guard on the WRONG variable is not a guard. This is
                // the case a "does an `if` wrap the call?" check would
                // wave through.
                name: 'an if testing a different variable does not guard this one',
                code: `
                    let tenantA: string;
                    let ownerId: string;
                    afterAll(async () => {
                        if (ownerId) {
                            await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                        }
                    });
                `,
                errors: [failOpen],
            },
            {
                // Documented false positive, pinned so a future reader
                // sees it was a decision and not an oversight: an early
                // return IS a correct guard, and the rule flags it
                // anyway because recognising it needs statement-order
                // reasoning the rule does not do. Fails CLOSED.
                name: 'KNOWN FALSE POSITIVE — an early return is a real guard the rule cannot see',
                code: `
                    let tenantA: string;
                    afterAll(async () => {
                        if (!tenantA) return;
                        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
                    });
                `,
                errors: [failOpen],
            },
        ],
    });

    it('names the variable and the method in the message, so the report is actionable', () => {
        const linter = new Linter();
        const messages = linter.verify(
            `let tenantA;
             afterAll(async () => {
                 await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
             });`,
            {
                plugins: { local: { rules: { 'r': rule } } },
                rules: { 'local/r': 'error' },
            },
        );
        expect(messages).toHaveLength(1);
        expect(messages[0].message).toContain('`tenantA`');
        expect(messages[0].message).toContain('deleteMany');
        expect(messages[0].message).toContain('db-helper.ts');
    });
});
