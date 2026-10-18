/**
 * The one rule the acceptance usecase refuses with and the harness tab decides
 * its accept action from (#3687). If these two ever disagreed, the action would
 * be shown and then refused, or hidden from the one person entitled to it.
 */
import {
    acceptAffordanceFor,
    shortfallAcceptanceRefusal,
    type AcceptanceSubject,
} from '@/lib/agentic/harness-acceptance-rules';

const OWNER = 'usr_owner';
const OTHER = 'usr_other';

/** H2 with write reach is below the H3 bar; H3 is at it. */
const subject = (over: Partial<AcceptanceSubject> = {}): AcceptanceSubject => ({
    lastLevel: 'H2',
    lastReach: 'WRITE_OR_EXTERNAL',
    registeredAgent: { ownerUserId: OWNER, deletedAt: null },
    ...over,
});

describe('shortfallAcceptanceRefusal — the usecase\'s order', () => {
    it('lets the owner accept a shortfall', () => {
        expect(shortfallAcceptanceRefusal(subject(), OWNER)).toBeNull();
    });

    it('refuses a shadow agent for being shadow BEFORE asking whose it is', () => {
        // Nobody owns a shadow agent, so "not the owner" would be the wrong
        // answer — and asked of a non-owner, the order is what decides.
        expect(shortfallAcceptanceRefusal(subject({ registeredAgent: null }), OTHER)).toBe('SHADOW');
        expect(shortfallAcceptanceRefusal(subject({ registeredAgent: null }), OWNER)).toBe('SHADOW');
    });

    it('treats a register row deleted after the scan as shadow', () => {
        const deleted = subject({ registeredAgent: { ownerUserId: OWNER, deletedAt: new Date() } });
        expect(shortfallAcceptanceRefusal(deleted, OWNER)).toBe('SHADOW');
        const serialised = subject({ registeredAgent: { ownerUserId: OWNER, deletedAt: '2026-10-01T00:00:00.000Z' } });
        expect(shortfallAcceptanceRefusal(serialised, OWNER)).toBe('SHADOW');
    });

    it('refuses a non-owner BEFORE telling them whether there is anything to accept', () => {
        expect(shortfallAcceptanceRefusal(subject(), OTHER)).toBe('NOT_OWNER');
        expect(shortfallAcceptanceRefusal(subject({ lastLevel: 'H3' }), OTHER)).toBe('NOT_OWNER');
    });

    it('refuses the owner when the agent is at its bar', () => {
        expect(shortfallAcceptanceRefusal(subject({ lastLevel: 'H3' }), OWNER)).toBe('NO_SHORTFALL');
        expect(shortfallAcceptanceRefusal(subject({ lastLevel: 'H2', lastReach: 'READ_ONLY' }), OWNER)).toBe('NO_SHORTFALL');
    });

    it('holds unknown reach to the higher bar', () => {
        expect(shortfallAcceptanceRefusal(subject({ lastLevel: 'H2', lastReach: 'UNKNOWN' }), OWNER)).toBeNull();
    });
});

describe('acceptAffordanceFor — what the tab offers', () => {
    it.each([
        ['the owner, short, nothing in force', subject(), OWNER, false, 'ACCEPT'],
        ['the owner, short, an acceptance in force', subject(), OWNER, true, 'RENEW'],
        ['another admin, short', subject(), OTHER, false, 'OWNER_ONLY'],
        ['another admin, short, in force', subject(), OTHER, true, 'OWNER_ONLY'],
        ['anyone, short shadow agent', subject({ registeredAgent: null }), OWNER, false, 'REGISTER_FIRST'],
        ['the owner, at the bar', subject({ lastLevel: 'H3' }), OWNER, false, 'NONE'],
        ['another admin, at the bar', subject({ lastLevel: 'H3' }), OTHER, false, 'NONE'],
        // A shadow agent that is not short gets no note: there is nothing to accept.
        ['a shadow agent at the bar', subject({ registeredAgent: null, lastLevel: 'H4' }), OWNER, false, 'NONE'],
    ] as const)('%s → %s', (_label, agent, user, inForce, expected) => {
        expect(acceptAffordanceFor(agent, user, inForce)).toBe(expected);
    });

    it('offers an action exactly when the usecase would accept', () => {
        // Over every combination the two functions can see.
        const levels = ['H0', 'H1', 'H2', 'H3', 'H4', 'H5'] as const;
        const reaches = ['READ_ONLY', 'WRITE_OR_EXTERNAL', 'UNKNOWN'] as const;
        const registers = [null, { ownerUserId: OWNER, deletedAt: null }, { ownerUserId: OWNER, deletedAt: new Date() }];
        for (const lastLevel of levels)
            for (const lastReach of reaches)
                for (const registeredAgent of registers)
                    for (const user of [OWNER, OTHER])
                        for (const inForce of [false, true]) {
                            const agent = { lastLevel, lastReach, registeredAgent };
                            const offered = ['ACCEPT', 'RENEW'].includes(acceptAffordanceFor(agent, user, inForce));
                            expect(offered).toBe(shortfallAcceptanceRefusal(agent, user) === null);
                        }
    });
});
