/**
 * #2879 finding 58 — who this product acts as when it raises a review nobody
 * asked for.
 *
 * ═══ WHY A SETTING WAS NEEDED AT ALL ═══
 *
 * The finding reads "no job ever creates an access-review campaign", and that
 * is a consequence rather than an oversight. `Task.createdByUserId` is NOT
 * NULL, and `context-system.ts` says what that costs a background job: a
 * synthetic principal "fails at RUNTIME on the constraint". The review flow
 * wants `assertCanAdmin` plus a named reviewer on top. So a scheduled pass
 * could not raise either artefact, and the product had no way to name an
 * accountable human — `Tenant` carries no owner, and no job in `src/` picked
 * an administrator to act as.
 *
 * ═══ WHAT THESE TESTS PIN ═══
 *
 * That a NAME IS NOT A GRANT. The configured id is resolved through the real
 * membership every time, so a nominee who is demoted or removed loses the
 * ability instead of keeping an ADMIN-shaped context nobody re-checked —
 * the exact escalation `buildDelegatedJobContext`'s docblock records being
 * bitten by, where "a READER who owns a policy had an ADMIN-authority write
 * committed under their name".
 *
 * And that EVERY REFUSAL IS NAMED. Three outcomes rather than a nullable,
 * because "nobody was nominated" and "the nominee has left" are a settings
 * task and an offboarding consequence, and a tenant that cannot tell them
 * apart cannot fix either.
 */
const findUnique = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique } }),
    ),
}));

const mockResolveMember = jest.fn();
jest.mock('@/app-layer/context-system', () => ({
    ...jest.requireActual('@/app-layer/context-system'),
    resolveMemberContext: (...a: unknown[]) => mockResolveMember(...a),
}));

import { resolveRecertificationOwner } from '@/app-layer/usecases/recertification-owner';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('when no owner is nominated', () => {
    it('answers `unset` — and never asks the membership table', async () => {
        findUnique.mockResolvedValue({ recertificationOwnerUserId: null });

        const r = await resolveRecertificationOwner('t1', 'hris-sync');

        expect(r).toStrictEqual({ kind: 'unset' });
        expect(mockResolveMember).not.toHaveBeenCalled();
    });

    it('answers `unset` when the settings row does not exist at all', async () => {
        findUnique.mockResolvedValue(null);

        expect(await resolveRecertificationOwner('t1', 'hris-sync')).toStrictEqual({ kind: 'unset' });
    });
});

describe('when the nominee no longer holds the tenant', () => {
    it('REFUSES rather than falling back to a system context', async () => {
        // The assertion the whole design rests on. `resolveMemberContext`
        // returns null for a membership that is absent or not ACTIVE, and
        // anything other than a refusal here re-opens the escalation it exists
        // to close.
        findUnique.mockResolvedValue({ recertificationOwnerUserId: 'u-gone' });
        mockResolveMember.mockResolvedValue(null);

        const r = await resolveRecertificationOwner('t1', 'hris-sync');

        expect(r).toStrictEqual({ kind: 'unresolvable', userId: 'u-gone' });
    });

    it('is DISTINCT from `unset`, because they are different things to fix', async () => {
        // "We never configured this" is a settings task. "The person we
        // configured has left" is an offboarding consequence, and it means the
        // tenant's automated recertification stopped working on the day that
        // person was deactivated — silently, which is the decay the finding is
        // about.
        findUnique.mockResolvedValue({ recertificationOwnerUserId: 'u-gone' });
        mockResolveMember.mockResolvedValue(null);
        const gone = await resolveRecertificationOwner('t1', 'hris-sync');

        findUnique.mockResolvedValue({ recertificationOwnerUserId: null });
        const never = await resolveRecertificationOwner('t1', 'hris-sync');

        expect(gone.kind).not.toBe(never.kind);
    });
});

describe('when the nominee is an active member', () => {
    it('returns the context resolved from their REAL role', async () => {
        const memberCtx = { userId: 'u1', tenantId: 't1', role: 'ADMIN' };
        findUnique.mockResolvedValue({ recertificationOwnerUserId: 'u1' });
        mockResolveMember.mockResolvedValue(memberCtx);

        const r = await resolveRecertificationOwner('t1', 'hris-sync');

        expect(r).toStrictEqual({ kind: 'ready', userId: 'u1', ctx: memberCtx });
    });

    it('resolves the membership on EVERY call, not once at configuration time', async () => {
        // A name stored months ago is not evidence of a seat held today.
        findUnique.mockResolvedValue({ recertificationOwnerUserId: 'u1' });
        mockResolveMember.mockResolvedValue({ userId: 'u1' });

        await resolveRecertificationOwner('t1', 'hris-sync');
        await resolveRecertificationOwner('t1', 'hris-sync');

        expect(mockResolveMember).toHaveBeenCalledTimes(2);
    });

    it('names the calling job, so a row written on this context says which pass raised it', async () => {
        findUnique.mockResolvedValue({ recertificationOwnerUserId: 'u1' });
        mockResolveMember.mockResolvedValue({ userId: 'u1' });

        await resolveRecertificationOwner('t1', 'hris-sync');

        expect(mockResolveMember).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't1', userId: 'u1', job: 'hris-sync' }),
        );
    });
});
