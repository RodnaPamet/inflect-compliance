/**
 * Unit tests for src/app-layer/usecases/mfa.ts
 *
 * The load-bearing behaviour is the anti-lockout safeguard on
 * `updateTenantMfaPolicy`: flipping the policy to REQUIRED while nobody who
 * could flip it BACK has MFA enrolled.
 *
 * TWO CLAIMS THIS FILE USED TO MAKE, BOTH FALSE, BOTH CORRECTED HERE.
 *
 * "would lock every admin out FOREVER" — it would not. `isMfaAllowedPath`
 * (src/lib/auth/guard.ts) admits `/api/t/:slug/security/mfa/enroll` while
 * `mfaPending`, so REQUIRED-with-nobody-enrolled forces everyone through
 * enrolment on next sign-in rather than sealing them out. Overstating the
 * consequence is what made the next claim look harmless.
 *
 * "tenant with zero ADMINs — no lockout possible if no one to lock out" —
 * there is always someone. The trigger in
 * `20260424220000_epic1_last_owner_trigger` raises if any tenant would reach
 * zero `role = 'OWNER' AND status = 'ACTIVE'` rows, so every tenant has at
 * least one active OWNER by construction. And `canAdmin` is
 * `ROLE_ORDER[role] >= 4`, which OWNER=5 satisfies — so an OWNER could call
 * this function while a query filtering `role: 'ADMIN'` could not see one.
 *
 * Since `createTenantWithOwner` writes one OWNER and no ADMIN, "zero ADMINs"
 * was not an edge case at all: it was the DEFAULT tenant shape, and the test
 * asserting it accepts REQUIRED was pinning the safeguard's no-op as correct.
 * The query now selects OWNER + ADMIN, ACTIVE only.
 *
 * Behaviours protected:
 *   1. Only canAdmin can update the policy
 *   2. REQUIRED rejected when nobody admin-capable has verified MFA
 *   3. REQUIRED accepted when at least one is enrolled
 *   4. OPTIONAL / DISABLED bypass the lockout check entirely
 *   5. An OWNER-only tenant is COUNTED, not skipped — the regression above
 *   6. DEACTIVATED / INVITED members do not satisfy the safeguard
 *   7. getTenantSecuritySettings + getUserMfaStatus defaulting
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantMembership: { findMany: jest.fn() },
        userMfaEnrollment: { count: jest.fn(), findUnique: jest.fn() },
        tenantSecuritySettings: { upsert: jest.fn(), findUnique: jest.fn() },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    getTenantSecuritySettings,
    getUserMfaStatus,
    updateTenantMfaPolicy,
} from '@/app-layer/usecases/mfa';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../../helpers/make-context';
import { AppError, ForbiddenError, ValidationError } from '@/lib/errors/types';

const mockMembershipFind = prisma.tenantMembership.findMany as jest.MockedFunction<
    typeof prisma.tenantMembership.findMany
>;
const mockEnrollCount = prisma.userMfaEnrollment.count as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.count
>;
const mockSettingsUpsert = prisma.tenantSecuritySettings.upsert as jest.MockedFunction<
    typeof prisma.tenantSecuritySettings.upsert
>;
const mockSettingsFind = prisma.tenantSecuritySettings.findUnique as jest.MockedFunction<
    typeof prisma.tenantSecuritySettings.findUnique
>;
const mockEnrollFind = prisma.userMfaEnrollment.findUnique as jest.MockedFunction<
    typeof prisma.userMfaEnrollment.findUnique
>;

const settingsRow = {
    id: 's1',
    tenantId: 't1',
    mfaPolicy: 'OPTIONAL' as const,
    sessionMaxAgeMinutes: null,
    auditWebhookUrl: null,
    auditWebhookSecretEncrypted: null,
    createdAt: new Date(),
    updatedAt: new Date(),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockMembershipFind.mockResolvedValue([] as never);
    mockEnrollCount.mockResolvedValue(0);
    mockSettingsUpsert.mockResolvedValue(settingsRow as never);
    mockSettingsFind.mockResolvedValue(null as never);
    mockEnrollFind.mockResolvedValue(null as never);
});

describe('updateTenantMfaPolicy', () => {
    it('rejects EDITOR — only canAdmin can update policy', async () => {
        await expect(
            updateTenantMfaPolicy(makeRequestContext('EDITOR'), {
                mfaPolicy: 'OPTIONAL',
            } as never),
        ).rejects.toThrow(/Only admins/);
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    // ── Anti-lockout: the load-bearing test ──
    it('rejects REQUIRED when no admin has verified MFA enrollment', async () => {
        mockMembershipFind.mockResolvedValue([
            { userId: 'admin-1' },
            { userId: 'admin-2' },
        ] as never);
        mockEnrollCount.mockResolvedValue(0); // ZERO enrolled admins

        await expect(
            updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
                mfaPolicy: 'REQUIRED',
            } as never),
        ).rejects.toThrow(/at least one active owner or admin must be enrolled/);
        // Regression: a bug that flipped the policy first and counted later
        // would force every member through enrolment before anyone could
        // switch it back. `not.toHaveBeenCalled` is load-bearing here — the
        // rejection alone does not say the write was skipped, only that
        // something threw.
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    it('accepts REQUIRED when at least one admin has verified MFA', async () => {
        mockMembershipFind.mockResolvedValue([
            { userId: 'admin-1' },
            { userId: 'admin-2' },
        ] as never);
        mockEnrollCount.mockResolvedValue(1); // exactly one enrolled

        const r = await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'REQUIRED',
        } as never);

        expect(mockSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-1' },
                create: expect.objectContaining({ mfaPolicy: 'REQUIRED' }),
                update: expect.objectContaining({ mfaPolicy: 'REQUIRED' }),
            }),
        );
        expect(r).toBeTruthy();
    });

    it('skips the lockout check when policy is OPTIONAL', async () => {
        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'OPTIONAL',
        } as never);
        // Regression: a bug that ran the count check on every policy
        // change would unnecessarily block OPTIONAL → DISABLED transitions.
        expect(mockEnrollCount).not.toHaveBeenCalled();
        expect(mockSettingsUpsert).toHaveBeenCalled();
    });

    it('skips the lockout check when policy is DISABLED', async () => {
        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'DISABLED',
        } as never);
        expect(mockEnrollCount).not.toHaveBeenCalled();
    });

    // ── The regression this file previously pinned as correct ────────
    //
    // A tenant whose only admin-capable member is the OWNER is the DEFAULT
    // shape, not an edge case: `createTenantWithOwner` writes one OWNER and
    // no ADMIN. Under `role: 'ADMIN'` the membership query came back empty,
    // the enrolment count was skipped, and REQUIRED went through with nobody
    // enrolled. The old test asserted exactly that and called it "no lockout
    // possible".
    //
    // The mock below FILTERS, and that is the whole point. A
    // `mockResolvedValue([{ userId: 'owner-1' }])` hands back the OWNER row
    // no matter what the query asked for, so it passes just as happily under
    // `role: 'ADMIN'` — measured, not assumed: with a filter-blind mock,
    // reverting the fix left this test green and only the `where`-shape
    // assertions went red. A mock that ignores the filter cannot test the
    // filter.
    const seedMembers = (rows: Array<{ userId: string; role: string; status: string }>) => {
        // `args` is left UNANNOTATED so it is contextually typed by Prisma's
        // own `findMany` signature. Annotating it with the narrow shape this
        // mock cares about compiles under jest and fails `tsc`: Prisma
        // declares `(args?: …)`, so the parameter must accept `undefined` and
        // the full arg union — see the `jest.fn(impl)` inference trap. Narrow
        // at the read instead.
        mockMembershipFind.mockImplementation((args) => {
            const where = (args?.where ?? {}) as {
                role?: { in?: string[] } | string;
                status?: string;
            };
            const roleFilter = where.role;
            const allowed = typeof roleFilter === 'string'
                ? [roleFilter]
                : roleFilter?.in ?? null;
            const hits = rows
                .filter((r) => (allowed === null ? true : allowed.includes(r.role)))
                .filter((r) => (where.status === undefined ? true : r.status === where.status))
                .map((r) => ({ userId: r.userId }));
            // Not `async`, and the return is cast: Prisma's findMany returns a
            // BRANDED `PrismaPromise` (`[Symbol.toStringTag]: 'PrismaPromise'`),
            // which a plain `Promise` from an async function is not assignable
            // to. jest accepts the async form happily; `tsc` does not.
            return Promise.resolve(hits) as never;
        });
    };

    it('counts an OWNER-only tenant rather than skipping the check', async () => {
        seedMembers([{ userId: 'owner-1', role: 'OWNER', status: 'ACTIVE' }]);
        mockEnrollCount.mockResolvedValue(0);

        await expect(
            updateTenantMfaPolicy(makeRequestContext('OWNER'), {
                mfaPolicy: 'REQUIRED',
            } as never),
        ).rejects.toThrow(/at least one active owner or admin must be/i);

        // The assertion that matters: the count RAN. Under the old query the
        // OWNER was invisible, so this was never reached.
        expect(mockEnrollCount).toHaveBeenCalled();
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    it('does not let a DEACTIVATED admin satisfy the safeguard', async () => {
        seedMembers([
            { userId: 'owner-1', role: 'OWNER', status: 'ACTIVE' },
            { userId: 'admin-gone', role: 'ADMIN', status: 'DEACTIVATED' },
        ]);
        // Only the deactivated admin has MFA — but they cannot sign in, so
        // the policy would not be recoverable through them.
        mockEnrollCount.mockImplementation((args) => {
            const where = (args?.where ?? {}) as { userId?: { in?: string[] } };
            const ids = where.userId?.in ?? [];
            return Promise.resolve(ids.includes('admin-gone') ? 1 : 0) as never;
        });

        await expect(
            updateTenantMfaPolicy(makeRequestContext('OWNER'), {
                mfaPolicy: 'REQUIRED',
            } as never),
        ).rejects.toThrow(/at least one active owner or admin must be/i);
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    it('queries OWNER and ADMIN, ACTIVE only', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(1);

        await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
        } as never);

        // `[0][0]` is optional because Prisma types findMany as `(args?: …)`.
        // Asserting it is defined is the point of the read, so do that rather
        // than reaching through with `!`.
        const call = mockMembershipFind.mock.calls[0][0];
        expect(call).toBeDefined();
        const where = call?.where as {
            role?: { in?: string[] };
            status?: string;
        };
        // Sorted so the assertion does not depend on declaration order.
        expect([...(where.role?.in ?? [])].sort()).toEqual(['ADMIN', 'OWNER']);
        // A DEACTIVATED or REMOVED member cannot sign in, so their enrolment
        // does not make the policy recoverable; INVITED never had a session.
        expect(where.status).toBe('ACTIVE');
    });

    it('accepts REQUIRED when the enrolled member is the OWNER', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(1);

        await expect(
            updateTenantMfaPolicy(makeRequestContext('OWNER'), {
                mfaPolicy: 'REQUIRED',
            } as never),
        ).resolves.toBeDefined();
        expect(mockSettingsUpsert).toHaveBeenCalled();
    });

    // Retained deliberately. The trigger in
    // 20260424220000_epic1_last_owner_trigger guarantees every tenant keeps an
    // active OWNER, so an empty list means that invariant broke rather than
    // that the tenant is unmanned. Skipping the count is what the old code did
    // and is the same answer; the branch exists so the behaviour is stated
    // rather than incidental.
    it('skips the count when the membership query returns nothing', async () => {
        mockMembershipFind.mockResolvedValue([] as never);
        await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
        } as never);
        expect(mockEnrollCount).not.toHaveBeenCalled();
        expect(mockSettingsUpsert).toHaveBeenCalled();
    });

    it('admin-membership query is scoped to ctx.tenantId — never cross-tenant', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'a' }] as never);
        mockEnrollCount.mockResolvedValue(1);
        await updateTenantMfaPolicy(makeRequestContext('ADMIN', { tenantId: 'tenant-X' }), {
            mfaPolicy: 'REQUIRED',
        } as never);
        expect(mockMembershipFind).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    tenantId: 'tenant-X',
                    role: { in: ['OWNER', 'ADMIN'] },
                    status: 'ACTIVE',
                }),
            }),
        );
        expect(mockEnrollCount).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-X', isVerified: true }),
            }),
        );
    });

    it('persists sessionMaxAgeMinutes when provided', async () => {
        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'OPTIONAL',
            sessionMaxAgeMinutes: 60,
        } as never);
        const upsertArgs = mockSettingsUpsert.mock.calls[0][0];
        expect(upsertArgs.create.sessionMaxAgeMinutes).toBe(60);
        expect(upsertArgs.update.sessionMaxAgeMinutes).toBe(60);
    });

    it('persists null sessionMaxAgeMinutes when omitted', async () => {
        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'OPTIONAL',
        } as never);
        const upsertArgs = mockSettingsUpsert.mock.calls[0][0];
        expect(upsertArgs.create.sessionMaxAgeMinutes).toBeNull();
    });
});

// ─── getTenantSecuritySettings ──────────────────────────────────────
//
// Both functions below were entirely uncovered — the file imported only
// `updateTenantMfaPolicy`, which is most of why mfa.ts sat at 25% branches.
// Their whole behaviour IS defaulting, so the absent-row arm is the one
// worth pinning: a tenant with no TenantSecuritySettings row must read as
// DISABLED, never as undefined, because `mfaRequired` and every middleware
// decision downstream compare against that value.

describe('getTenantSecuritySettings', () => {
    it('defaults to DISABLED / null when no settings row exists', async () => {
        mockSettingsFind.mockResolvedValue(null as never);
        await expect(getTenantSecuritySettings(makeRequestContext('ADMIN'))).resolves.toEqual({
            mfaPolicy: 'DISABLED',
            sessionMaxAgeMinutes: null,
        });
    });

    it('returns the stored policy and session cap when a row exists', async () => {
        mockSettingsFind.mockResolvedValue({
            ...settingsRow,
            mfaPolicy: 'REQUIRED',
            sessionMaxAgeMinutes: 30,
        } as never);
        await expect(getTenantSecuritySettings(makeRequestContext('READER'))).resolves.toEqual({
            mfaPolicy: 'REQUIRED',
            sessionMaxAgeMinutes: 30,
        });
    });

    // A row that exists with a null cap must stay null rather than being
    // coerced — `?? null` and a missing row are different states upstream
    // even though they read the same here.
    it('keeps a null sessionMaxAgeMinutes on an existing row', async () => {
        mockSettingsFind.mockResolvedValue({ ...settingsRow, sessionMaxAgeMinutes: null } as never);
        const out = await getTenantSecuritySettings(makeRequestContext('ADMIN'));
        expect(out.sessionMaxAgeMinutes).toBeNull();
        expect(out.mfaPolicy).toBe('OPTIONAL');
    });

    it('reads scoped to ctx.tenantId', async () => {
        await getTenantSecuritySettings(makeRequestContext('ADMIN', { tenantId: 'tenant-Y' }));
        expect(mockSettingsFind).toHaveBeenCalledWith({ where: { tenantId: 'tenant-Y' } });
    });
});

// ─── getUserMfaStatus ───────────────────────────────────────────────

describe('getUserMfaStatus', () => {
    it('reports not-enrolled when the user has no enrollment row', async () => {
        mockEnrollFind.mockResolvedValue(null as never);
        mockSettingsFind.mockResolvedValue(null as never);
        await expect(getUserMfaStatus(makeRequestContext('EDITOR'))).resolves.toEqual({
            isEnrolled: false,
            isVerified: false,
            enrolledAt: null,
            verifiedAt: null,
            tenantMfaPolicy: 'DISABLED',
            mfaRequired: false,
        });
    });

    // The state that matters operationally: a row exists but was never
    // verified. `isEnrolled` is true and `isVerified` is false, and only the
    // second one governs whether the anti-lockout count above sees this user
    // — that count filters `isVerified: true`.
    it('separates enrolled from verified', async () => {
        const created = new Date('2026-01-01T00:00:00Z');
        mockEnrollFind.mockResolvedValue({
            isVerified: false,
            createdAt: created,
            verifiedAt: null,
        } as never);
        const out = await getUserMfaStatus(makeRequestContext('EDITOR'));
        expect(out.isEnrolled).toBe(true);
        expect(out.isVerified).toBe(false);
        expect(out.enrolledAt).toEqual(created);
        expect(out.verifiedAt).toBeNull();
    });

    it('surfaces a verified enrollment with both timestamps', async () => {
        const created = new Date('2026-01-01T00:00:00Z');
        const verified = new Date('2026-01-02T00:00:00Z');
        mockEnrollFind.mockResolvedValue({
            isVerified: true,
            createdAt: created,
            verifiedAt: verified,
        } as never);
        const out = await getUserMfaStatus(makeRequestContext('EDITOR'));
        expect(out.isVerified).toBe(true);
        expect(out.verifiedAt).toEqual(verified);
    });

    it('sets mfaRequired only for REQUIRED, not OPTIONAL', async () => {
        mockSettingsFind.mockResolvedValue({ ...settingsRow, mfaPolicy: 'REQUIRED' } as never);
        await expect(getUserMfaStatus(makeRequestContext('EDITOR'))).resolves.toMatchObject({
            tenantMfaPolicy: 'REQUIRED',
            mfaRequired: true,
        });

        mockSettingsFind.mockResolvedValue({ ...settingsRow, mfaPolicy: 'OPTIONAL' } as never);
        await expect(getUserMfaStatus(makeRequestContext('EDITOR'))).resolves.toMatchObject({
            tenantMfaPolicy: 'OPTIONAL',
            mfaRequired: false,
        });
    });

    // Both reads are keyed on the caller's OWN ids. A status endpoint that
    // read another user's enrolment would be a cross-user leak, and the
    // composite key is the only thing preventing it.
    it('keys the enrollment read on the caller userId + tenantId + TOTP', async () => {
        await getUserMfaStatus(makeRequestContext('EDITOR', { userId: 'u-9', tenantId: 't-9' }));
        expect(mockEnrollFind).toHaveBeenCalledWith({
            where: { userId_tenantId_type: { userId: 'u-9', tenantId: 't-9', type: 'TOTP' } },
        });
        expect(mockSettingsFind).toHaveBeenCalledWith({ where: { tenantId: 't-9' } });
    });
});

// ─── Defects that survived 100% branch coverage ─────────────────────
//
// Everything above this line already executed every branch in mfa.ts — the
// file measured 100/100/100/100 before this block was written. Six source
// mutations were nonetheless applied one at a time and the whole suite stayed
// green for all six:
//
//   1. `mfaPolicy: settings.mfaPolicy`   → `input.mfaPolicy`
//   2. `sessionMaxAgeMinutes: settings.…`→ `input.sessionMaxAgeMinutes ?? null`
//   3. the count's `type: 'TOTP'` filter  deleted
//   4. the `canAdmin` guard               moved BELOW the anti-lockout block
//   5. `throw badRequest(…)`             → `throw forbidden(…)`
//   6. `input.mfaPolicy === 'REQUIRED'`  → `!== 'DISABLED'`
//
// Each is a real defect (a lie about what was stored, a safeguard satisfied by
// the wrong factor, a roster read by someone who may not administer the
// tenant, a 403 where the client must see a 400, a roster read on a policy
// change that needs none). Executing a line proved none of them. The tests
// below assert the observable DIFFERENCE each one erases.

describe('updateTenantMfaPolicy — what the caller is told, and what is read', () => {
    // Kills mutations 1 and 2.
    //
    // The return value is the caller's only report of what is now in force,
    // and it must come from the row Postgres actually wrote — not from the
    // request. A column default, a concurrent write, or a mid-deploy schema
    // skew all make those two differ, and echoing the input would report
    // success for a policy that was never stored.
    //
    // The fixture makes them differ ON PURPOSE, on BOTH fields: the request
    // asks for REQUIRED / 15, the persisted row comes back OPTIONAL / 45.
    // A fixture where the requested and stored values coincide cannot tell
    // `settings.mfaPolicy` from `input.mfaPolicy` no matter how it asserts.
    it('reports the PERSISTED row, not the requested input', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(1);
        mockSettingsUpsert.mockResolvedValue({
            ...settingsRow,
            mfaPolicy: 'OPTIONAL',
            sessionMaxAgeMinutes: 45,
        } as never);

        const result = await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
            sessionMaxAgeMinutes: 15,
        } as never);

        // toStrictEqual, not toEqual: an `undefined` field would satisfy
        // toEqual against an absent one, and "the policy is undefined" is
        // exactly the shape a broken read returns.
        expect(result).toStrictEqual({ mfaPolicy: 'OPTIONAL', sessionMaxAgeMinutes: 45 });

        // And the write itself still carried the REQUEST — the two values are
        // separate for a reason, so pin both directions.
        const upsertArgs = mockSettingsUpsert.mock.calls[0][0];
        expect(upsertArgs.update.mfaPolicy).toBe('REQUIRED');
        expect(upsertArgs.update.sessionMaxAgeMinutes).toBe(15);
    });

    // Kills mutation 3.
    //
    // The safeguard asks "can anybody still turn this off?", and only a
    // verified TOTP factor answers yes — that is the factor the MFA challenge
    // actually accepts. An enrolment row of another type must NOT satisfy it,
    // or REQUIRED goes on with nobody able to complete a challenge.
    //
    // Asserting the `type: 'TOTP'` key appears in the query would be weaker:
    // it pins the spelling of the filter, not its effect. This mock holds a
    // small enrolment table and HONOURS the filter, so deleting the filter
    // changes the outcome from a refusal to an acceptance.
    it('does not let a non-TOTP enrolment satisfy the anti-lockout check', async () => {
        const enrolments: Array<{ userId: string; type: string; isVerified: boolean }> = [
            // The tenant's only owner has a verified factor — but not TOTP.
            { userId: 'owner-1', type: 'SMS', isVerified: true },
        ];
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        // Unannotated `args` — contextually typed by Prisma's own `count`
        // signature; annotating it compiles under jest and fails tsc.
        mockEnrollCount.mockImplementation((args) => {
            const where = (args?.where ?? {}) as {
                userId?: { in?: string[] };
                type?: string;
                isVerified?: boolean;
            };
            const ids = where.userId?.in ?? [];
            const hits = enrolments.filter(
                (e) =>
                    ids.includes(e.userId) &&
                    (where.type === undefined || e.type === where.type) &&
                    (where.isVerified === undefined || e.isVerified === where.isVerified),
            );
            return Promise.resolve(hits.length) as never;
        });

        const err = await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
        } as never).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    // The contrasting arm of the test above: the SAME filter-honouring mock,
    // with the factor changed to TOTP, must accept. Without this the previous
    // test would also pass against a function that refuses unconditionally.
    it('accepts once that same owner holds a verified TOTP factor', async () => {
        const enrolments: Array<{ userId: string; type: string; isVerified: boolean }> = [
            { userId: 'owner-1', type: 'TOTP', isVerified: true },
        ];
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockImplementation((args) => {
            const where = (args?.where ?? {}) as {
                userId?: { in?: string[] };
                type?: string;
                isVerified?: boolean;
            };
            const ids = where.userId?.in ?? [];
            const hits = enrolments.filter(
                (e) =>
                    ids.includes(e.userId) &&
                    (where.type === undefined || e.type === where.type) &&
                    (where.isVerified === undefined || e.isVerified === where.isVerified),
            );
            return Promise.resolve(hits.length) as never;
        });
        mockSettingsUpsert.mockResolvedValue({
            ...settingsRow,
            mfaPolicy: 'REQUIRED',
        } as never);

        const result = await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
        } as never);

        expect(result.mfaPolicy).toBe('REQUIRED');
        expect(mockSettingsUpsert).toHaveBeenCalled();
    });

    // Kills mutation 5.
    //
    // The two refusals are NOT interchangeable at the HTTP boundary: the
    // lockout is a 400 the admin can act on ("enrol first, then retry"), the
    // role denial is a 403 that also writes an authz denial upstream. Swapping
    // `badRequest` for `forbidden` turns actionable advice into "you may not
    // do this", and every message-substring assertion in this file stays green
    // through it, because the message is unchanged.
    it('refuses the lockout with a 400 ValidationError, not a 403', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(0);

        const err = await updateTenantMfaPolicy(makeRequestContext('OWNER'), {
            mfaPolicy: 'REQUIRED',
        } as never).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect(err).not.toBeInstanceOf(ForbiddenError);
        expect((err as AppError).status).toBe(400);
        expect((err as AppError).code).toBe('BAD_REQUEST');
    });

    it('refuses a non-admin with a 403 ForbiddenError', async () => {
        const err = await updateTenantMfaPolicy(makeRequestContext('EDITOR'), {
            mfaPolicy: 'OPTIONAL',
        } as never).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as AppError).status).toBe(403);
        expect((err as AppError).code).toBe('FORBIDDEN');
    });

    // Kills mutation 4.
    //
    // Order, not just outcome. With the guard below the safeguard, an EDITOR
    // asking for REQUIRED reaches two tenant-wide reads before being refused,
    // and is answered "enrol MFA first" — a message that tells a member who
    // cannot administer the tenant both that the roster was consulted and that
    // the policy is theirs to set. The fixture is seeded so the misordered
    // version throws a DIFFERENT error as well as reading: owner present,
    // nobody enrolled.
    it('refuses a non-admin BEFORE reading the membership roster', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(0);

        const err = await updateTenantMfaPolicy(makeRequestContext('EDITOR'), {
            mfaPolicy: 'REQUIRED',
        } as never).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ForbiddenError);
        expect(mockMembershipFind).not.toHaveBeenCalled();
        expect(mockEnrollCount).not.toHaveBeenCalled();
        expect(mockSettingsUpsert).not.toHaveBeenCalled();
    });

    // Kills mutation 6.
    //
    // The existing OPTIONAL test asserts only that the COUNT was skipped, and
    // the count is skipped for an empty roster anyway — so widening the
    // trigger from `=== 'REQUIRED'` to `!== 'DISABLED'` left it green while
    // every OPTIONAL policy change started reading the tenant roster. The
    // roster read is the first observable step, so assert on that one.
    it('does not read the roster at all for an OPTIONAL policy change', async () => {
        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'OPTIONAL',
        } as never);

        expect(mockMembershipFind).not.toHaveBeenCalled();
        expect(mockEnrollCount).not.toHaveBeenCalled();
        expect(mockSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: expect.objectContaining({ mfaPolicy: 'OPTIONAL' }) }),
        );
    });

    // The other arm: REQUIRED must read it. Without this, the test above is
    // satisfied by a function that never reads the roster for anything.
    it('does read the roster for a REQUIRED policy change', async () => {
        mockMembershipFind.mockResolvedValue([{ userId: 'owner-1' }] as never);
        mockEnrollCount.mockResolvedValue(1);

        await updateTenantMfaPolicy(makeRequestContext('ADMIN'), {
            mfaPolicy: 'REQUIRED',
        } as never);

        expect(mockMembershipFind).toHaveBeenCalledTimes(1);
        expect(mockEnrollCount).toHaveBeenCalledTimes(1);
    });
});
