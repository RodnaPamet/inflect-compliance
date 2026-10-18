/**
 * Agent credential hygiene — each rule proved by a fixture it fires on and a
 * clean credential it does not (#3670). Pure: `lib/agentic/credential-hygiene`.
 * The database half (findings written, reopened and resolved; nothing written
 * to a credential; two-tenant isolation) is
 * `tests/integration/agent-credential-hygiene.test.ts`.
 */
import {
    connectionRuleHits,
    DEFAULT_KEY_ROTATION_DAYS,
    hygieneSourceRef,
    isLiveKey,
    keyRuleHits,
    parseHygieneSourceRef,
    planHygiene,
    RULE_SEVERITY,
    type ConnectionFacts,
    type KeyFacts,
} from '@/lib/agentic/credential-hygiene';

const DAY = 86_400_000;
const NOW = new Date('2026-11-02T06:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);

/** A key that fires NOTHING: used yesterday, expires, young, bound to an agent. */
function cleanKey(over: Partial<KeyFacts> = {}): KeyFacts {
    return {
        id: 'k-clean',
        name: 'clean',
        keyPrefix: 'iflk_cln',
        createdAt: daysAgo(10),
        lastUsedAt: daysAgo(1),
        expiresAt: daysAhead(60),
        revokedAt: null,
        agentId: 'agent-1',
        ...over,
    };
}

const rotation = DEFAULT_KEY_ROTATION_DAYS;

describe('the clean key fires no rule', () => {
    it('fires nothing', () => {
        expect(keyRuleHits(cleanKey(), NOW, rotation)).toEqual([]);
    });
});

describe('KEY_UNUSED_30_DAYS', () => {
    it('fires on a live key last used 31 days ago', () => {
        expect(keyRuleHits(cleanKey({ lastUsedAt: daysAgo(31) }), NOW, rotation)).toEqual(['KEY_UNUSED_30_DAYS']);
    });
    it('fires on a key never used and created 31 days ago', () => {
        expect(keyRuleHits(cleanKey({ lastUsedAt: null, createdAt: daysAgo(31) }), NOW, rotation)).toEqual([
            'KEY_UNUSED_30_DAYS',
        ]);
    });
    it('does not fire on a key used 29 days ago, or never used and minted 29 days ago', () => {
        expect(keyRuleHits(cleanKey({ lastUsedAt: daysAgo(29) }), NOW, rotation)).toEqual([]);
        expect(keyRuleHits(cleanKey({ lastUsedAt: null, createdAt: daysAgo(29) }), NOW, rotation)).toEqual([]);
    });
});

describe('KEY_NO_EXPIRY', () => {
    it('fires on a live key with no expiry', () => {
        expect(keyRuleHits(cleanKey({ expiresAt: null }), NOW, rotation)).toEqual(['KEY_NO_EXPIRY']);
    });
    it('does not fire on a key that expires', () => {
        expect(keyRuleHits(cleanKey({ expiresAt: daysAhead(1) }), NOW, rotation)).toEqual([]);
    });
});

describe('KEY_OLDER_THAN_ROTATION_AGE — the 90-day default, there being no tenant setting', () => {
    it('is 90 days', () => {
        expect(DEFAULT_KEY_ROTATION_DAYS).toBe(90);
    });
    it('fires on a live key created 91 days ago', () => {
        expect(keyRuleHits(cleanKey({ createdAt: daysAgo(91) }), NOW, rotation)).toEqual([
            'KEY_OLDER_THAN_ROTATION_AGE',
        ]);
    });
    it('does not fire on a key created 89 days ago', () => {
        expect(keyRuleHits(cleanKey({ createdAt: daysAgo(89) }), NOW, rotation)).toEqual([]);
    });
    it('reads the age it is given, so a tenant setting would only have to pass one', () => {
        expect(keyRuleHits(cleanKey({ createdAt: daysAgo(20) }), NOW, 14)).toEqual(['KEY_OLDER_THAN_ROTATION_AGE']);
    });
});

describe('KEY_NOT_BOUND_TO_AGENT', () => {
    it('fires on a live key bound to no agent', () => {
        expect(keyRuleHits(cleanKey({ agentId: null }), NOW, rotation)).toEqual(['KEY_NOT_BOUND_TO_AGENT']);
    });
    it('does not fire on a key bound to an agent', () => {
        expect(keyRuleHits(cleanKey({ agentId: 'agent-9' }), NOW, rotation)).toEqual([]);
    });
});

describe('a key that is not live fires nothing — revoked or past its expiry', () => {
    it.each([
        ['revoked', { revokedAt: daysAgo(1) }],
        ['expired', { expiresAt: daysAgo(1) }],
    ])('%s', (_label, over) => {
        const weak = cleanKey({ lastUsedAt: null, createdAt: daysAgo(400), agentId: null, ...over });
        expect(isLiveKey(weak, NOW)).toBe(false);
        expect(keyRuleHits(weak, NOW, rotation)).toEqual([]);
    });
});

describe('CONNECTION_APP_ONLY_NO_OWNER', () => {
    const conn = (over: Partial<ConnectionFacts>): ConnectionFacts => ({
        id: 'c1',
        name: 'vendor mcp',
        grantKind: 'app-only',
        namedOwnerUserId: null,
        ...over,
    });

    it('fires on an app-only connection with no named owner', () => {
        expect(connectionRuleHits(conn({}))).toEqual(['CONNECTION_APP_ONLY_NO_OWNER']);
        expect(RULE_SEVERITY.CONNECTION_APP_ONLY_NO_OWNER).toBe('HIGH');
    });

    it('does not fire on an app-only connection that names an owner', () => {
        expect(connectionRuleHits(conn({ namedOwnerUserId: 'user-1' }))).toEqual([]);
    });

    it.each(['delegated', 'static-header', 'none', 'invalid'] as const)('does not fire on a %s grant', (grantKind) => {
        expect(connectionRuleHits(conn({ grantKind }))).toEqual([]);
    });

    it('judges nothing about a connection whose secret could not be read', () => {
        expect(connectionRuleHits(conn({ grantKind: 'unreadable' }))).toEqual([]);
    });
});

describe('planHygiene — assert, resolve, hold', () => {
    it('asserts one finding per (rule, credential), with a parseable ref', () => {
        const weak = cleanKey({ id: 'k-weak', expiresAt: null, agentId: null });
        const plan = planHygiene({ keys: [weak], connections: [], openRefs: [], now: NOW, rotationDays: rotation });
        expect(plan.assert.map((f) => f.sourceRef).sort()).toEqual([
            'KEY_NOT_BOUND_TO_AGENT:api_key:k-weak',
            'KEY_NO_EXPIRY:api_key:k-weak',
        ]);
        expect(parseHygieneSourceRef(plan.assert[0].sourceRef)).toEqual({
            rule: plan.assert[0].rule,
            kind: 'api_key',
            id: 'k-weak',
        });
    });

    it('resolves on positive evidence: a key no longer live, or live and passing', () => {
        const plan = planHygiene({
            keys: [cleanKey({ id: 'k-fixed' })],
            connections: [],
            openRefs: [
                hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', 'k-fixed'),
                hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', 'k-revoked-since'),
            ],
            now: NOW,
            rotationDays: rotation,
        });
        expect(plan.assert).toEqual([]);
        expect(plan.resolve.sort()).toEqual([
            'KEY_NO_EXPIRY:api_key:k-fixed',
            'KEY_NO_EXPIRY:api_key:k-revoked-since',
        ]);
        expect(plan.held).toEqual([]);
    });

    it('HOLDS a connection it could not judge — neither raised nor resolved', () => {
        const ref = hygieneSourceRef('CONNECTION_APP_ONLY_NO_OWNER', 'connection', 'c-locked');
        const plan = planHygiene({
            keys: [],
            connections: [{ id: 'c-locked', name: 'x', grantKind: 'unreadable', namedOwnerUserId: null }],
            openRefs: [ref],
            now: NOW,
            rotationDays: rotation,
        });
        expect(plan.assert).toEqual([]);
        expect(plan.resolve).toEqual([]);
        expect(plan.held).toEqual([ref]);
        expect(plan.unjudgeableConnectionIds).toEqual(['c-locked']);
    });

    it('a still-firing open finding is asserted again, not resolved', () => {
        const ref = hygieneSourceRef('KEY_NO_EXPIRY', 'api_key', 'k-still');
        const plan = planHygiene({
            keys: [cleanKey({ id: 'k-still', expiresAt: null })],
            connections: [],
            openRefs: [ref],
            now: NOW,
            rotationDays: rotation,
        });
        expect(plan.assert.map((f) => f.sourceRef)).toEqual([ref]);
        expect(plan.resolve).toEqual([]);
    });
});
