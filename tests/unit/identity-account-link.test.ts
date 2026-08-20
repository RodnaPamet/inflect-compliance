/**
 * Worker <-> account matching: what it links, and everything it refuses to.
 *
 * The refusals carry the weight here. Under JML an INCORRECT link disables the
 * wrong person's account and writes an audit trail saying the offboarding
 * succeeded; a MISSING link is a refusal somebody can see and fix. Those two
 * failure modes are not symmetric, so every ambiguous case below must resolve
 * toward the visible one.
 */
const db = {
    employee: { findMany: jest.fn() },
    connectedIdentityAccount: { findMany: jest.fn() },
    identityAccountLink: {
        findMany: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

import { reconcileIdentityAccountLinks } from '@/app-layer/usecases/identity-account-link';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });
const NOW = new Date('2026-08-19T21:00:00Z');

/** The rows createMany was asked to write. */
function created(): Array<Record<string, unknown>> {
    const call = db.identityAccountLink.createMany.mock.calls[0];
    return call ? (call[0].data as Array<Record<string, unknown>>) : [];
}

beforeEach(() => {
    jest.clearAllMocks();
    db.employee.findMany.mockResolvedValue([]);
    db.connectedIdentityAccount.findMany.mockResolvedValue([]);
    db.identityAccountLink.findMany.mockResolvedValue([]);
    db.identityAccountLink.createMany.mockResolvedValue({ count: 0 });
    db.identityAccountLink.updateMany.mockResolvedValue({ count: 0 });
});

describe('an exact email match links', () => {
    it('links one account to one employee', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.createMany.mockResolvedValue({ count: 1 });

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.created).toBe(1);
        expect(created()[0]).toMatchObject({
            tenantId: 't1',
            employeeId: 'e1',
            connectedAccountId: 'a1',
            matchMethod: 'EMAIL_EXACT',
        });
    });

    it('normalises case and surrounding whitespace on both sides', async () => {
        // Directory casing and HR casing routinely disagree; refusing on case
        // alone would leave most of a real directory unlinked.
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: '  Ada@Acme.COM ' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ADA@acme.com' }]);
        db.identityAccountLink.createMany.mockResolvedValue({ count: 1 });

        expect((await reconcileIdentityAccountLinks(ctx, 'okta', NOW)).created).toBe(1);
    });

    it('links SEVERAL accounts to the same worker', async () => {
        // Entra + Okta + on-prem AD for one person. Disabling all of them is
        // the point, so the model must not be unique on employeeId.
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([
            { id: 'a1', email: 'ada@acme.com' },
            { id: 'a2', email: 'ada@acme.com' },
        ]);
        db.identityAccountLink.createMany.mockResolvedValue({ count: 2 });

        await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(created()).toHaveLength(2);
        expect(created().map((r) => r.employeeId)).toEqual(['e1', 'e1']);
    });
});

describe('every ambiguity resolves to NO link', () => {
    it('an account matching no employee is reported, not guessed at', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'svc-backup@acme.com' }]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.created).toBe(0);
        expect(r.unmatched).toBe(1);
        expect(db.identityAccountLink.createMany).not.toHaveBeenCalled();
    });

    it('an email claimed by TWO employees links to neither', async () => {
        // Picking either is a coin flip that later disables someone. A shared
        // address is a data problem, not a match.
        db.employee.findMany.mockResolvedValue([
            { id: 'e1', workEmail: 'shared@acme.com' },
            { id: 'e2', workEmail: 'shared@acme.com' },
        ]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'shared@acme.com' }]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.created).toBe(0);
        expect(r.unmatched).toBe(1);
    });

    it('an account already linked to a DIFFERENT worker is not re-pointed, but IS marked', async () => {
        // Silently re-pointing it would move a future disable from one person
        // to another — still refused.
        //
        // But leaving it entirely untouched was its own defect, found by
        // adversarial review: `lastVerifiedAt` is only ever set to `now`, so a
        // pairing this pass DISPROVED kept a recent stamp and stayed eligible
        // for a leaver disable for the rest of its freshness window. It is now
        // marked contradicted, and the candidate query excludes that.
        db.employee.findMany.mockResolvedValue([{ id: 'e2', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.findMany.mockResolvedValue([{ connectedAccountId: 'a1', employeeId: 'e1' }]);
        db.identityAccountLink.updateMany.mockResolvedValue({ count: 1 });

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.created).toBe(0);
        expect(r.unmatched).toBe(1);
        expect(r.contradicted).toBe(1);
        expect(db.identityAccountLink.createMany).not.toHaveBeenCalled();

        // Marked, NOT re-pointed and NOT deleted: the link is the record of a
        // pairing we once had good reason to believe.
        const mark = db.identityAccountLink.updateMany.mock.calls[0][0];
        expect(mark.data).toEqual({ contradictedAt: NOW });
        expect(mark.where.connectedAccountId).toEqual({ in: ['a1'] });
        expect(mark.where.contradictedAt).toBeNull();
    });

    it('re-confirming a pairing CLEARS a previous contradiction', async () => {
        // The evidence that disproved it has itself been superseded.
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.findMany.mockResolvedValue([{ connectedAccountId: 'a1', employeeId: 'e1' }]);
        db.identityAccountLink.updateMany.mockResolvedValue({ count: 1 });

        await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(db.identityAccountLink.updateMany.mock.calls[0][0].data).toEqual({
            lastVerifiedAt: NOW, contradictedAt: null,
        });
    });

    it('an account with a blank email matches nothing', async () => {
        // Otherwise every blank-email account would collide into one key and
        // link to whichever employee also lacked an address.
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: '' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([
            { id: 'a1', email: '' },
            { id: 'a2', email: null },
        ]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.created).toBe(0);
        expect(r.unmatched).toBe(2);
    });
});

describe('an unresolved account is IDENTIFIED, not just counted', () => {
    /**
     * `unmatched` was only ever a number. "37 unmatched" tells an operator
     * nothing about WHICH accounts, and the three reasons want different
     * responses: a service account should be excluded, a shared address is a
     * data problem to fix, and an account linked to someone else is a conflict
     * to resolve.
     *
     * It matters most during a leaver rollout, because an account with no HR
     * counterpart is one the offboarding will never disable — and nobody would
     * know which.
     */
    it('names the account and says NO_EMPLOYEE when nobody holds the address', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a-svc', email: 'svc-backup@acme.com' }]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.unmatched).toBe(1);
        expect(r.unresolved).toEqual([{ connectedAccountId: 'a-svc', reason: 'NO_EMPLOYEE' }]);
    });

    it('distinguishes AMBIGUOUS_EMPLOYEE from NO_EMPLOYEE', async () => {
        // They look identical downstream and are not: one is a data problem to
        // fix, the other is usually a service account to exclude.
        db.employee.findMany.mockResolvedValue([
            { id: 'e1', workEmail: 'shared@acme.com' },
            { id: 'e2', workEmail: 'shared@acme.com' },
        ]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'shared@acme.com' }]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.unresolved).toEqual([{ connectedAccountId: 'a1', reason: 'AMBIGUOUS_EMPLOYEE' }]);
    });

    it('reports LINKED_ELSEWHERE for an account already bound to another worker', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e2', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.findMany.mockResolvedValue([{ connectedAccountId: 'a1', employeeId: 'e1' }]);
        db.identityAccountLink.updateMany.mockResolvedValue({ count: 1 });

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.unresolved).toEqual([{ connectedAccountId: 'a1', reason: 'LINKED_ELSEWHERE' }]);
    });

    it('carries the account id, never the email address', async () => {
        // The id identifies the row for an operator who can look it up under
        // tenant scope. The email would put a person's address into a log line
        // that is neither encrypted nor tenant-scoped.
        db.employee.findMany.mockResolvedValue([]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(JSON.stringify(r.unresolved)).not.toContain('ada@acme.com');
    });

    it('is BOUNDED — a directory with no HR data at all cannot produce a second dataset', async () => {
        db.employee.findMany.mockResolvedValue([]);
        db.connectedIdentityAccount.findMany.mockResolvedValue(
            Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, email: `u${i}@acme.com` })),
        );

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.unmatched).toBe(300);
        // The COUNT stays true while the sample is capped — losing the true
        // count would be worse than losing the ids.
        expect(r.unresolved.length).toBeLessThanOrEqual(50);
    });
});

describe('re-observing an existing link refreshes its evidence', () => {
    it('re-stamps lastVerifiedAt rather than creating a duplicate', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.findMany.mockResolvedValue([{ connectedAccountId: 'a1', employeeId: 'e1' }]);
        db.identityAccountLink.updateMany.mockResolvedValue({ count: 1 });

        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(r.verified).toBe(1);
        expect(r.created).toBe(0);
        expect(db.identityAccountLink.createMany).not.toHaveBeenCalled();
        expect(db.identityAccountLink.updateMany.mock.calls[0][0].data.lastVerifiedAt).toBe(NOW);
    });

    it('scopes the re-stamp to this tenant', async () => {
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.findMany.mockResolvedValue([{ connectedAccountId: 'a1', employeeId: 'e1' }]);
        db.identityAccountLink.updateMany.mockResolvedValue({ count: 1 });

        await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(db.identityAccountLink.updateMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1' });
    });
});

describe('the reads are bounded and tenant-scoped', () => {
    it('both population reads carry a take and a tenantId', async () => {
        await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        for (const call of [db.employee.findMany, db.connectedIdentityAccount.findMany]) {
            const q = call.mock.calls[0][0];
            expect(typeof q.take).toBe('number');
            expect(q.where.tenantId).toBe('t1');
        }
    });

    it('the account read is scoped to the provider being synced', async () => {
        await reconcileIdentityAccountLinks(ctx, 'entra-id', NOW);
        expect(db.connectedIdentityAccount.findMany.mock.calls[0][0].where.provider).toBe('entra-id');
    });

    it('does not issue a query per account', async () => {
        // The whole matching pass is two population reads plus one link read;
        // a per-account lookup would be an N+1 over the directory.
        db.employee.findMany.mockResolvedValue(
            Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, workEmail: `u${i}@acme.com` })),
        );
        db.connectedIdentityAccount.findMany.mockResolvedValue(
            Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, email: `u${i}@acme.com` })),
        );
        db.identityAccountLink.createMany.mockResolvedValue({ count: 50 });

        await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(db.identityAccountLink.findMany).toHaveBeenCalledTimes(1);
        expect(db.identityAccountLink.createMany).toHaveBeenCalledTimes(1);
        expect(created()).toHaveLength(50);
    });

    it('writes nothing at all when there is nothing to write', async () => {
        // An empty directory must not issue a createMany with an empty array.
        const r = await reconcileIdentityAccountLinks(ctx, 'okta', NOW);
        expect(db.identityAccountLink.createMany).not.toHaveBeenCalled();
        expect(db.identityAccountLink.updateMany).not.toHaveBeenCalled();
        expect(r).toEqual({ created: 0, verified: 0, unmatched: 0, contradicted: 0, unresolved: [] });
    });

    it('tolerates a concurrent pass creating the same link', async () => {
        // skipDuplicates: the unique on connectedAccountId is the real arbiter,
        // and losing that race must be a no-op rather than an error.
        db.employee.findMany.mockResolvedValue([{ id: 'e1', workEmail: 'ada@acme.com' }]);
        db.connectedIdentityAccount.findMany.mockResolvedValue([{ id: 'a1', email: 'ada@acme.com' }]);
        db.identityAccountLink.createMany.mockResolvedValue({ count: 0 });

        await expect(reconcileIdentityAccountLinks(ctx, 'okta', NOW)).resolves.toMatchObject({ created: 0 });
        expect(db.identityAccountLink.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    });
});
