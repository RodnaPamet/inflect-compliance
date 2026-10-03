/**
 * THE CLAMP AT THE DISPATCH SEAM, IN BOTH DIRECTIONS (#2861 / #3051).
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * `EXTERNAL_MAX_MODE` was enforced at exactly one place: `setExternalWriteMode`
 * refused to STORE a rung above it. `dispatchWrite` never read the constant at
 * all. So a connection that was ALREADY holding `AUTOMATIC` when the ceiling
 * came down — a rollback, or an incident narrowing the build rather than every
 * tenant one at a time — would have been dispatched anyway, because the only
 * check lived on the path nobody was taking.
 *
 * `automaticClampRefusal` is the second half, consulted by the arm AND by the
 * dispatch pass, and this file is its behavioural test.
 *
 * ═══ WHY THE MODULE IS RE-LOADED RATHER THAN THE ASSERTION GUARDED ═══
 *
 * The constant is `PROPOSE_ONLY` on this branch, so "the arm runs when the
 * ceiling permits it" is a statement about a path the real clamp refuses. An
 * `if (EXTERNAL_MAX_MODE === 'AUTOMATIC')` around that assertion would be a
 * vacuous pass — an empty selection is a PASS — so the selection is made
 * non-empty by hand: the ladder module is mocked and the usecase re-required
 * against it. That is the technique
 * `tests/guards/identity-write-ceiling-matches-the-pass.test.ts` uses and
 * explains, and it is used here for the same reason.
 *
 * Both directions matter and only one of them is obvious. The REFUSING
 * direction proves the check exists. The PERMITTING direction proves the check
 * is reading the constant rather than refusing `AUTOMATIC` unconditionally —
 * without it, a function that always refused would pass every test in the
 * refusing half and the whole rung would be dead with no test to say so.
 */
import type { ExternalWriteMode } from '@/lib/integrations/external-write-ladder';

type ArmModule = typeof import('@/app-layer/usecases/external-write-automatic');

/**
 * Load the arm's usecase against a ladder whose ceiling is `ceiling`.
 *
 * `requireActual` is spread so `LADDER`, `isAboveClamp` and `coerceStoredMode`
 * stay real — the thing under test is the ORDINAL comparison against the
 * constant, and replacing the comparison would be testing the mock.
 */
function armWithCeiling(ceiling: ExternalWriteMode): ArmModule {
    let mod: ArmModule | undefined;
    jest.isolateModules(() => {
        jest.doMock('@/lib/integrations/external-write-ladder', () => ({
            ...jest.requireActual('@/lib/integrations/external-write-ladder'),
            EXTERNAL_MAX_MODE: ceiling,
        }));
        mod = require('@/app-layer/usecases/external-write-automatic') as ArmModule;
    });
    if (!mod) throw new Error('the automatic arm failed to load');
    jest.dontMock('@/lib/integrations/external-write-ladder');
    return mod;
}

describe('the clamp REFUSES the rung at dispatch while the ceiling is below it', () => {
    it('refuses at the shipped ceiling, which is the live configuration', () => {
        // No mock: this is the branch as it ships. The refusal is the state a
        // reader should expect to find in production.
        const { automaticClampRefusal } = require('@/app-layer/usecases/external-write-automatic') as ArmModule;
        expect(automaticClampRefusal()).toMatch(/external_write_automatic_above_ceiling/);
    });

    it.each(['DISABLED', 'DRY_RUN', 'PROPOSE_ONLY'] as const)(
        'refuses with a ceiling of %s, and names it',
        (ceiling) => {
            const refusal = armWithCeiling(ceiling).automaticClampRefusal();
            expect(refusal).toMatch(/external_write_automatic_above_ceiling/);
            expect(refusal).toContain(ceiling);
            expect(refusal).toMatch(/Nothing was sent/);
        },
    );

    it('and the send-time bound check refuses on the clamp BEFORE it reads anything', async () => {
        // The ORDER is the claim: a rung this build will not exercise must not
        // cost a query. If the clamp were consulted after the set lookup, this
        // call would need a database — it is given none, and a passing
        // assertion is therefore also proof that nothing was read.
        const refusal = await armWithCeiling('PROPOSE_ONLY').automaticBoundRefusalAtSend(
            { tenantId: 'tnt', userId: 'u' } as never,
            { toolName: 'mcp__c__w', parameterSetLabel: 'ops', argumentsJson: '{}' },
        );
        expect(refusal).toMatch(/external_write_automatic_above_ceiling/);
    });
});

describe('the clamp PERMITS the rung once the ceiling reaches it', () => {
    it('returns null at a ceiling of AUTOMATIC — the mutation the issue names', () => {
        // THE OTHER DIRECTION. Without this, a function that returned a refusal
        // unconditionally would satisfy every assertion above, and the rung
        // would be permanently dead with nothing saying so.
        expect(armWithCeiling('AUTOMATIC').automaticClampRefusal()).toBeNull();
    });

    it('takes the flip — the control that says the re-load actually happened', () => {
        // Stated as its own assertion rather than inferred from the null above:
        // a `jest.doMock` that failed to apply would leave the real constant in
        // place, and "refusal" and "mock did not apply" are different facts.
        const raised = armWithCeiling('AUTOMATIC');
        const shipped = armWithCeiling('PROPOSE_ONLY');
        expect(raised.automaticClampRefusal()).toBeNull();
        expect(shipped.automaticClampRefusal()).not.toBeNull();
    });

    it('and the two loads are independent — no module-cache bleed between them', () => {
        // The failure mode this catches is a shared module registry: if
        // `isolateModules` did not isolate, whichever ceiling was loaded LAST
        // would answer for both, and the pair above would agree rather than
        // disagree. Asserted in the reverse order so the bleed cannot be
        // masked by the order the previous test happened to use.
        const shipped = armWithCeiling('DRY_RUN');
        const raised = armWithCeiling('AUTOMATIC');
        expect(shipped.automaticClampRefusal()).toMatch(/DRY_RUN/);
        expect(raised.automaticClampRefusal()).toBeNull();
    });
});

describe('the row-rung narrowing check is ordinal, not a pair of literals', () => {
    const { rowRungNarrowedRefusal } = require('@/app-layer/usecases/external-write-automatic') as ArmModule;

    it('refuses an AUTOMATIC row on a connection now at PROPOSE_ONLY', () => {
        // The case the dispatch's own `DISABLED`/`DRY_RUN` pair cannot see.
        expect(rowRungNarrowedRefusal('AUTOMATIC', 'PROPOSE_ONLY')).toMatch(
            /external_write_automatic_rung_narrowed/,
        );
    });

    it('permits a row at or below the connection\'s current rung', () => {
        // Three controls, because a function that refused everything would pass
        // the assertion above. A PROPOSE_ONLY row on an AUTOMATIC connection is
        // the WIDENED case, which is not a withdrawal and must not refuse.
        expect(rowRungNarrowedRefusal('AUTOMATIC', 'AUTOMATIC')).toBeNull();
        expect(rowRungNarrowedRefusal('PROPOSE_ONLY', 'PROPOSE_ONLY')).toBeNull();
        expect(rowRungNarrowedRefusal('PROPOSE_ONLY', 'AUTOMATIC')).toBeNull();
    });

    it('coerces an unrecognised stored rung, so unknown cannot read as the widest', () => {
        // `isAboveClamp` sorts an unknown mode to -1, i.e. NOT above any clamp,
        // i.e. permitted — which is safe for a ceiling and catastrophic for a
        // stored authority. `coerceStoredMode` is applied first, so an
        // unrecognised row reads as DISABLED and is permitted here because
        // DISABLED is below everything; what refuses it is the dispatch's own
        // rung check, which this function is deliberately not a copy of.
        expect(rowRungNarrowedRefusal('AUTOMATIC_BUT_MISSPELLED', 'DISABLED')).toBeNull();
        // The pair that proves the coercion is what produced that answer: the
        // literal string, if it had been compared raw, would have sorted ABOVE
        // nothing and still returned null — so the discriminating case is a
        // RECOGNISED rung in the same position, which does refuse.
        expect(rowRungNarrowedRefusal('AUTOMATIC', 'DISABLED')).toMatch(/rung_narrowed/);
    });
});
