/**
 * #3297 — resolving a tenant's Entra entitlement connection, and the four
 * refusals that are not each other.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * ────────────────────────────────
 * Two things, and the first is the security-relevant one:
 *
 *   1. TWO ENABLED CONNECTIONS REFUSES, IT DOES NOT CHOOSE. "Which directory
 *      does this grant write to" has no safe default. A resolver that took the
 *      first row by id order would write to a directory nobody named, and it
 *      would do so silently and consistently — the worst combination, because
 *      it looks correct until the wrong tenant's accounts change. This is why
 *      the read is `take: 2` rather than `take: 1`: one row cannot tell "the
 *      only connection" from "the first of several".
 *   2. A BAD EXPIRY COSTS NO DATABASE READ AND NO KEY MATERIAL. The expiry
 *      refusal runs before the connection is resolved, so a grant that must not
 *      happen touches neither Prisma nor `decryptField`. The assertion is on the
 *      Prisma spy NOT being called, which is the only way to state it.
 *
 * WHY THE REFUSAL SENTENCES ARE ASSERTED AND NOT JUST THE KINDS
 * ────────────────────────────────────────────────────────────
 * Each of the four is fixed by a different action — connect a directory, disable
 * the extra ones, re-enter a secret, complete the config. A test that checked
 * only `kind` would pass with all four sentences saying "it did not work", which
 * is the exact collapse the module's header rejects.
 */
const findManyMock = jest.fn();
const runInTenantContextMock = jest.fn(
    async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ integrationConnection: { findMany: findManyMock } }),
);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (c: unknown, fn: (db: unknown) => unknown) =>
        runInTenantContextMock(c, fn),
}));

const decryptFieldMock = jest.fn((v: string) => v);
jest.mock('@/lib/security/encryption', () => ({
    decryptField: (v: string) => decryptFieldMock(v),
}));

import {
    describeEntitlementRefusal,
    grantTimeBoundedAccess,
    resolveEntraEntitlementConnection,
    ENTRA_PROVIDER,
    type EntraEntitlementRefusal,
} from '@/app-layer/usecases/entra-grant-dispatch';
import { MAX_GRANT_DAYS } from '@/app-layer/integrations/providers/entra-id/entitlement';
import { makeRequestContext } from '../helpers/make-context';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-09T12:00:00.000Z');
const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-A' });

const SECRETS = JSON.stringify({
    tenantId: '0fc6f345-0eee-4408-89a9-96fdd1b6439d',
    clientId: 'e8c77dc2-69b3-43f4-bc51-3213c9d915b4',
    clientSecret: 'shh', // pragma: allowlist secret -- test fixture
});

const conn = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1',
    configJson: {},
    secretEncrypted: SECRETS,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    decryptFieldMock.mockImplementation((v: string) => v);
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE RESOLUTION
// ═════════════════════════════════════════════════════════════════════

describe('resolveEntraEntitlementConnection — four refusals, four fixes', () => {
    it('resolves one enabled connection and merges its secrets — the control', async () => {
        findManyMock.mockResolvedValue([conn()]);
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state).toBe('ok');
        expect(r.state === 'ok' && r.connection.clientId).toBe(
            'e8c77dc2-69b3-43f4-bc51-3213c9d915b4',
        );
    });

    it('scopes the read to this tenant, this provider, and ENABLED only', async () => {
        findManyMock.mockResolvedValue([conn()]);
        await resolveEntraEntitlementConnection(ctx);
        const arg = findManyMock.mock.calls[0][0];
        expect(arg.where).toEqual({
            tenantId: 'tenant-A',
            provider: ENTRA_PROVIDER,
            isEnabled: true,
        });
        // Through runInTenantContext, never a global read — the claim is "this
        // workspace's directory", and a read outside a tenant context is one
        // RLS does not constrain.
        expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    });

    it('asks for TWO rows, so "the only one" is distinguishable from "the first"', async () => {
        findManyMock.mockResolvedValue([conn()]);
        await resolveEntraEntitlementConnection(ctx);
        expect(findManyMock.mock.calls[0][0].take).toBe(2);
    });

    it('REFUSES two enabled connections rather than choosing one', async () => {
        // The load-bearing assertion. A resolver that took the first row would
        // write to a directory nobody named, silently and consistently.
        findManyMock.mockResolvedValue([conn(), conn({ id: 'conn-2' })]);
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state === 'refused' && r.refusal.kind).toBe('ambiguous');
        expect(r.state === 'refused' && (r.refusal as { count: number }).count).toBe(2);
    });

    it('refuses when there is no enabled connection at all', async () => {
        findManyMock.mockResolvedValue([]);
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state === 'refused' && r.refusal.kind).toBe('no_connection');
    });

    it('refuses when the secret will not decrypt, carrying the cause not the ciphertext', async () => {
        findManyMock.mockResolvedValue([conn()]);
        decryptFieldMock.mockImplementation(() => {
            throw new Error('bad auth tag');
        });
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state === 'refused' && r.refusal.kind).toBe('secret_unavailable');
        const detail = r.state === 'refused' ? (r.refusal as { detail: string }).detail : '';
        expect(detail).toBe('bad auth tag');
        // The ciphertext must not travel with the message.
        expect(detail).not.toContain(SECRETS);
    });

    it('names the MISSING FIELD rather than letting the token exchange 401', async () => {
        // An empty clientSecret makes Entra answer 401 invalid_client, which
        // `resilientFetch` converts into an auth error and marks the connection
        // credential-failed — recording our own malformed request as "your
        // credentials are revoked". So it is checked here, by name.
        findManyMock.mockResolvedValue([
            conn({ secretEncrypted: JSON.stringify({ tenantId: 't', clientId: 'c' }) }),
        ]);
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state === 'refused' && r.refusal.kind).toBe('incomplete_config');
        expect(r.state === 'refused' && (r.refusal as { missing: string[] }).missing).toEqual([
            'clientSecret',
        ]);
    });

    it('treats a whitespace-only credential as missing', async () => {
        findManyMock.mockResolvedValue([
            conn({
                secretEncrypted: JSON.stringify({
                    tenantId: 't',
                    clientId: 'c',
                    clientSecret: '   ',
                }),
            }),
        ]);
        const r = await resolveEntraEntitlementConnection(ctx);
        expect(r.state === 'refused' && r.refusal.kind).toBe('incomplete_config');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. THE SENTENCES
// ═════════════════════════════════════════════════════════════════════

describe('describeEntitlementRefusal — four different actions, four sentences', () => {
    const CASES: ReadonlyArray<readonly [EntraEntitlementRefusal, RegExp]> = [
        [{ kind: 'no_connection' }, /Connect one under Admin/],
        [{ kind: 'ambiguous', count: 3 }, /disable the connections/],
        [{ kind: 'secret_unavailable', detail: 'x' }, /Re-enter the client secret/],
        [{ kind: 'incomplete_config', missing: ['clientId'] }, /Complete the connection/],
    ];

    it.each(CASES)('%j names what to do about it', (refusal, expected) => {
        const text = describeEntitlementRefusal(refusal);
        expect(text).toMatch(expected);
        // Each must say something an operator can act on — not "it did not work".
        expect(text.length).toBeGreaterThan(40);
    });

    it('every sentence is DISTINCT — a collapse would make the union pointless', () => {
        const texts = CASES.map(([r]) => describeEntitlementRefusal(r));
        expect(new Set(texts).size).toBe(CASES.length);
    });

    it('the ambiguous sentence quotes the count', () => {
        expect(describeEntitlementRefusal({ kind: 'ambiguous', count: 3 })).toContain('3 enabled');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. A BAD EXPIRY COSTS NOTHING
// ═════════════════════════════════════════════════════════════════════

describe('a refused expiry touches neither the database nor the key material', () => {
    it.each([
        ['an absent end date', new Date('nonsense')],
        ['a past end date', new Date(NOW.getTime() - DAY_MS)],
        ['beyond the cap', new Date(NOW.getTime() + (MAX_GRANT_DAYS + 1) * DAY_MS)],
    ])('%s — zero reads, zero decrypts', async (_label, endDateTime) => {
        const out = await grantTimeBoundedAccess(
            ctx,
            {
                targetId: '46184453-e63b-4f20-86c2-c557ed5d5df9',
                accessPackageId: 'pkg',
                assignmentPolicyId: 'pol',
                endDateTime,
            },
            NOW,
        );
        expect(out.ok).toBe(false);
        // The only way to state "this cost nothing": the spies.
        expect(findManyMock).not.toHaveBeenCalled();
        expect(decryptFieldMock).not.toHaveBeenCalled();
        expect(runInTenantContextMock).not.toHaveBeenCalled();
    });

    it('a VALID expiry does reach the resolution — the positive control', async () => {
        // Paired with the above, so "zero reads" is about the refusal and not
        // about this function never reading anything.
        findManyMock.mockResolvedValue([]);
        const out = await grantTimeBoundedAccess(
            ctx,
            {
                targetId: '46184453-e63b-4f20-86c2-c557ed5d5df9',
                accessPackageId: 'pkg',
                assignmentPolicyId: 'pol',
                endDateTime: new Date(NOW.getTime() + 7 * DAY_MS),
            },
            NOW,
        );
        expect(findManyMock).toHaveBeenCalledTimes(1);
        // Refused for a CONNECTION reason now, not an expiry one.
        expect(out.ok).toBe(false);
        expect(out.ok === false && out.refused).toMatch(/No enabled Entra ID connection/);
    });
});
