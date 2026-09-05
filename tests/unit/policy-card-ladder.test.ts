/**
 * The policy card's LADDER — widening is one rung, narrowing is free, and every
 * comparison is ORDINAL.
 *
 * ## Why this file exists rather than a reading of the code
 *
 * The identity subsystem shipped the equality bug once and it is written down in
 * `src/lib/identity/write-ladder.ts`: the leaver pass tested `mode !==
 * LEAVER_MAX_MODE`, which is correct only while the clamp sits at the second
 * rung. When the clamp moved to `AUTOMATIC`, a tenant at `DRY_RUN` was not equal
 * to it but was BELOW it, and the inequality refused a tenant that should have
 * run — a refusal that recorded no row, so the symptom was a blank page.
 *
 * Nothing about the shape of `!==` looks wrong. It reads correctly, it passes
 * every test written against the clamp of the day, and it only becomes a defect
 * when a constant somewhere else moves. That is the class of bug a test has to
 * pin by VALUE, at more than one distance, which is what the "two rungs below"
 * cases below are for. A test that only checked the rung equal to the ceiling
 * and the rung above it would pass against an `===` implementation.
 */
import { AgentDataAccessScope } from '@prisma/client';

import {
    ACTION_CAP_LADDER,
    APPROVAL_LADDER,
    DATA_SCOPE_LADDER,
    POLICY_CARD_RULES,
    autonomyWithinCard,
    checkLadderStep,
    comparePolicyCards,
    dataScopeWithinCard,
    permittedDataScopes,
    type AgentPolicyCardValue,
} from '@/lib/agentic/policy-card';

/** A mid-ladder card, so every dimension has room to move in both directions. */
const BASE: AgentPolicyCardValue = {
    permittedTools: ['list_risks', 'list_controls'],
    maxDataScope: 'READ_TENANT_DATA',
    maxAutonomyLevel: 3,
    maxActionsPerRun: 25,
    maxActionsPerDay: 250,
    escalationTriggers: [...POLICY_CARD_RULES],
    approvalRung: 'SINGLE_APPROVER',
};

const card = (over: Partial<AgentPolicyCardValue>): AgentPolicyCardValue => ({
    ...BASE,
    ...over,
});

describe('the ladder is ORDINAL, not an equality test', () => {
    it('a rung TWO BELOW the ceiling is permitted, on every ordinal dimension', () => {
        // The exact shape of the identity bug. `required === permitted` would
        // pass the first assertion of each pair and fail the second, and a suite
        // that only ever compared the ceiling to itself would never notice.
        expect(autonomyWithinCard(3, 3)).toBe(true);
        expect(autonomyWithinCard(1, 3)).toBe(true);
        expect(autonomyWithinCard(4, 3)).toBe(false);

        expect(dataScopeWithinCard('READ_TENANT_DATA', 'READ_TENANT_DATA')).toBe(true);
        expect(dataScopeWithinCard('NONE', 'READ_TENANT_DATA')).toBe(true);
        expect(dataScopeWithinCard('WRITE_TENANT_DATA', 'READ_TENANT_DATA')).toBe(false);
    });

    it('an UNRECOGNISED rung refuses, on both sides of the comparison', () => {
        // The mirror of `write-ladder.ts`'s -1 hazard, and the reason its
        // docstring insists the fail direction be read rather than assumed.
        // Here the rung is a CEILING, so an unknown value must refuse; there it
        // was the subject being clamped, so an unknown value was permissive and
        // needed `coerceStoredMode` in front of it.
        expect(dataScopeWithinCard('READ_METADATA', 'SOMETHING_NEWER' as AgentDataAccessScope))
            .toBe(false);
        expect(dataScopeWithinCard('SOMETHING_NEWER', 'EXTERNAL_EGRESS')).toBe(false);
        expect(autonomyWithinCard(2, 99)).toBe(false);
        expect(autonomyWithinCard(99, 6)).toBe(false);
    });

    it('the data-scope ladder IS the Prisma enum, in the enum\'s own order', () => {
        // The enum's doc comment says the order is load-bearing and the enum is
        // append-only. `satisfies` proves every rung here is a real member at
        // compile time; only this can prove the reverse — a member appended to
        // the schema with no rung here would sort to -1 and refuse every call
        // that reached it, which is a safe direction but a silent one.
        expect([...DATA_SCOPE_LADDER]).toEqual(Object.values(AgentDataAccessScope));
    });

    it('the permitted set is the PREFIX the ceiling implies', () => {
        expect(permittedDataScopes('NONE')).toEqual(['NONE']);
        expect(permittedDataScopes('READ_TENANT_DATA')).toEqual([
            'NONE',
            'READ_METADATA',
            'READ_TENANT_DATA',
        ]);
        expect(permittedDataScopes('EXTERNAL_EGRESS')).toHaveLength(
            DATA_SCOPE_LADDER.length,
        );
    });
});

describe('widening is ONE rung on ONE dimension', () => {
    it('one rung up is allowed, on each ordinal dimension in turn', () => {
        expect(checkLadderStep(BASE, card({ maxAutonomyLevel: 4 }))).toBeNull();
        expect(checkLadderStep(BASE, card({ maxDataScope: 'WRITE_TENANT_DATA' }))).toBeNull();
        expect(checkLadderStep(BASE, card({ maxActionsPerRun: 50 }))).toBeNull();
        expect(checkLadderStep(BASE, card({ maxActionsPerDay: 500 }))).toBeNull();
        expect(checkLadderStep(BASE, card({ approvalRung: 'AUTO_APPROVAL' }))).toBeNull();
    });

    it('TWO rungs in one edit is refused, and the message says which dimension', () => {
        const two = checkLadderStep(BASE, card({ maxAutonomyLevel: 5 }));
        expect(two?.reason).toBe('MULTI_RUNG_WIDEN');
        expect(two?.widenings).toEqual([
            expect.objectContaining({ dimension: 'maxAutonomyLevel', rungs: 2 }),
        ]);

        // A budget is ORDINAL for exactly this reason: 25 → 100 is two steps on
        // the ladder and a 4x increase in authority, and over the raw integers
        // "one rung" would have had no meaning to enforce.
        const budget = checkLadderStep(BASE, card({ maxActionsPerDay: 1000 }));
        expect(budget?.reason).toBe('MULTI_RUNG_WIDEN');
        expect(budget?.widenings[0]).toMatchObject({
            dimension: 'maxActionsPerDay',
            rungs: 2,
        });
    });

    it('one rung on TWO dimensions in one edit is refused', () => {
        const both = checkLadderStep(
            BASE,
            card({ maxAutonomyLevel: 4, maxDataScope: 'WRITE_TENANT_DATA' }),
        );
        expect(both?.reason).toBe('MULTI_DIMENSION_WIDEN');
        expect(both?.widenings.map((w) => w.dimension).sort()).toEqual([
            'maxAutonomyLevel',
            'maxDataScope',
        ]);
    });

    it('adding ONE tool is one rung; adding two is two', () => {
        expect(
            checkLadderStep(BASE, card({ permittedTools: [...BASE.permittedTools, 'list_tasks'] })),
        ).toBeNull();

        const twoTools = checkLadderStep(
            BASE,
            card({ permittedTools: [...BASE.permittedTools, 'list_tasks', 'list_findings'] }),
        );
        expect(twoTools?.reason).toBe('MULTI_RUNG_WIDEN');
        expect(twoTools?.widenings[0]).toMatchObject({ dimension: 'permittedTools', rungs: 2 });
    });

    it('DROPPING an escalation trigger is a widening; adding one is not', () => {
        // The sign is inverted against every other set on the card, which is the
        // kind of thing that is right in the head of whoever wrote it and wrong
        // six months later. Pinned in both directions.
        const quieter = checkLadderStep(
            BASE,
            card({ escalationTriggers: POLICY_CARD_RULES.slice(0, 3) }),
        );
        expect(quieter?.reason).toBe('MULTI_RUNG_WIDEN');
        expect(quieter?.widenings[0]).toMatchObject({
            dimension: 'escalationTriggers',
            rungs: 2,
        });

        const noisier = checkLadderStep(
            card({ escalationTriggers: [] }),
            card({ escalationTriggers: [...POLICY_CARD_RULES] }),
        );
        expect(noisier).toBeNull();
    });
});

describe('narrowing is free — any dimension, any distance, all at once', () => {
    it('the whole card collapsed to its floor in ONE edit is allowed', () => {
        // The incident case. A rule that made an operator walk an agent down one
        // rung at a time while it was misbehaving is a rule people route around,
        // and the ratchet is meant to slow only the direction that ADDS
        // authority.
        const floor = card({
            permittedTools: [],
            maxDataScope: 'NONE',
            maxAutonomyLevel: 0,
            maxActionsPerRun: 0,
            maxActionsPerDay: 0,
            approvalRung: 'SECOND_APPROVER',
        });
        expect(checkLadderStep(BASE, floor)).toBeNull();

        // …and it really did move every dimension, so the assertion above is not
        // passing because nothing changed.
        expect(comparePolicyCards(BASE, floor).length).toBeGreaterThanOrEqual(6);
        expect(comparePolicyCards(BASE, floor).every((d) => d.rungs < 0)).toBe(true);
    });

    it('narrowing several dimensions WHILE widening one by a rung is allowed', () => {
        expect(
            checkLadderStep(
                BASE,
                card({
                    maxAutonomyLevel: 4,
                    maxDataScope: 'READ_METADATA',
                    permittedTools: ['list_risks'],
                }),
            ),
        ).toBeNull();
    });

    it('a narrowing does NOT pay for a widening on the same dimension', () => {
        // Two tools removed and two added is a net widening of two, not a wash.
        // Each new reach is a decision on its own; the removals are unrelated
        // decisions that happen to be in the same edit.
        const swap = checkLadderStep(
            BASE,
            card({ permittedTools: ['list_tasks', 'list_findings'] }),
        );
        expect(swap?.reason).toBe('MULTI_RUNG_WIDEN');
        expect(swap?.widenings[0]).toMatchObject({ dimension: 'permittedTools', rungs: 2 });
        // The removals ARE reported — they are simply not subtracted from the
        // additions. Asserted so that a future "net delta" simplification, which
        // would make this edit legal, fails here rather than shipping.
        expect(comparePolicyCards(BASE, card({ permittedTools: ['list_tasks', 'list_findings'] })))
            .toEqual([
                expect.objectContaining({ dimension: 'permittedTools', rungs: 2 }),
                expect.objectContaining({ dimension: 'permittedTools', rungs: -2 }),
            ]);
    });

    it('an edit that changes nothing is allowed and reports no delta', () => {
        expect(comparePolicyCards(BASE, { ...BASE })).toEqual([]);
        expect(checkLadderStep(BASE, { ...BASE })).toBeNull();
    });
});

describe('the ladders themselves', () => {
    it('every ladder is strictly ordered and has no unlimited rung', () => {
        expect([...ACTION_CAP_LADDER]).toEqual([...ACTION_CAP_LADDER].sort((a, b) => a - b));
        expect(new Set(ACTION_CAP_LADDER).size).toBe(ACTION_CAP_LADDER.length);
        // An unbounded budget is the thing the card exists to prevent, so the
        // top of the ladder is a real number somebody has to choose.
        expect(Math.max(...ACTION_CAP_LADDER)).toBe(1000);
        expect(ACTION_CAP_LADDER).toContain(0);
    });

    it('the approval ladder runs STRICTEST to loosest', () => {
        // The direction is what makes "dropping to auto-approval" a widening. If
        // it were reversed, the one edit that removes every human from the loop
        // would be scored as a narrowing and allowed without limit.
        expect(APPROVAL_LADDER[0]).toBe('SECOND_APPROVER');
        expect(APPROVAL_LADDER[APPROVAL_LADDER.length - 1]).toBe('AUTO_APPROVAL');
        expect(
            checkLadderStep(
                card({ approvalRung: 'AUTO_APPROVAL' }),
                card({ approvalRung: 'SECOND_APPROVER' }),
            ),
        ).toBeNull();
        expect(
            checkLadderStep(
                card({ approvalRung: 'SECOND_APPROVER' }),
                card({ approvalRung: 'AUTO_APPROVAL' }),
            )?.reason,
        ).toBe('MULTI_RUNG_WIDEN');
    });
});
