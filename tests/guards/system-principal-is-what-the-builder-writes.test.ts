/**
 * `SYSTEM_PRINCIPAL` and what `buildSystemContext` actually writes must agree.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `identity-leaver-pass` decides whether a directory write was ATTENDED by
 * asking whether the context names a real person:
 *
 *     ctx.userId && ctx.userId !== SYSTEM_PRINCIPAL ? 'manual' : 'scheduled'
 *
 * That is two facts that must match — the constant, and the value the builder
 * stamps on a system context. Nothing in the type system holds them together,
 * and the failure is one-directional and toward the WRONG answer: if the
 * comparison stops matching, every unattended 05:00 pass is recorded as
 * `triggeredBy: 'manual'`, asserting a human asked for a write nobody asked
 * for. That is worse than the hole it replaced, which at least erred toward
 * "nobody".
 *
 * It is not hypothetical. `identity-leaver-pass.test.ts` mocked
 * `@/app-layer/context-system` with `buildSystemContext` alone; the constant
 * imported as `undefined`, `'system' !== undefined` read as attended, and
 * every scheduled run in that suite was labelled manual. A partial barrel mock
 * does not fail loudly — it returns a plausible wrong answer.
 *
 * This file deliberately does NOT mock the module, so it compares the real
 * export against the real builder.
 */
import { SYSTEM_PRINCIPAL, buildSystemContext } from '@/app-layer/context-system';

describe('the system principal is the value a system context carries', () => {
    it('is a non-empty string — an undefined constant is the failure mode', () => {
        // Asserted FIRST and separately: every comparison below is satisfied by
        // `undefined === undefined`, which is exactly the broken state.
        expect(typeof SYSTEM_PRINCIPAL).toBe('string');
        expect(SYSTEM_PRINCIPAL.length).toBeGreaterThan(0);
    });

    it('is exactly what buildSystemContext stamps on userId', () => {
        const ctx = buildSystemContext({ tenantId: 't-1', job: 'a-job' });
        expect(ctx.userId).toBe(SYSTEM_PRINCIPAL);
    });

    it('so the attended check reads a system context as UNATTENDED', () => {
        // The actual expression the pass uses, evaluated against the real
        // builder. This is the assertion that would have caught the mock bug
        // if the pass had been written test-first.
        const ctx = buildSystemContext({ tenantId: 't-1', job: 'a-job' });
        const attended = Boolean(ctx.userId && ctx.userId !== SYSTEM_PRINCIPAL);
        expect(attended).toBe(false);
    });

    it('and reads a named person as ATTENDED — the positive control', () => {
        // Typed as `string`, not left as a literal: with a literal TypeScript
        // narrows both sides and reports the comparison as unintentional and
        // always-truthy, which is a real complaint about a test that cannot
        // fail rather than noise to silence.
        const namedPerson: string = 'user-42';
        const attended = Boolean(namedPerson && namedPerson !== SYSTEM_PRINCIPAL);
        expect(attended).toBe(true);
    });
});
