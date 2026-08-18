/**
 * Tenant-wide calendar consent: an admin authority, audited as one.
 *
 * The row exists to answer one question — "offer this user Connect, or tell
 * them to ask their administrator?" — without a failed OAuth round trip to
 * discover a fact the tenant already knows.
 *
 * Most of what is asserted here is about the difference between a TENANT-WIDE
 * authorisation and a per-user one. Granting this admits every user in the
 * tenant to a third-party calendar API, so it is audited with a named author
 * and it survives that author's offboarding; connecting your own calendar is
 * neither.
 */
/**
 * Typed with its real parameter tuple so `mock.calls[0][2]` — the audit payload
 * — is inspectable. `jest.fn(async () => {})` infers a zero-length tuple, and
 * every assertion about the audit event is on that third argument.
 */
const logEvent = jest.fn<Promise<void>, [unknown, unknown, Record<string, unknown>]>(async () => {});
const db = {
    tenantCalendarConsent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) =>
        logEvent(...(a as [unknown, unknown, Record<string, unknown>])),
}));

import {
    recordAdminConsent,
    revokeAdminConsent,
    getConsentStates,
    requiresAdminConsent,
    ADMIN_CONSENT_PROVIDERS,
} from '@/app-layer/usecases/tenant-calendar-consent';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'admin-1' });
const PROVIDER = 'outlook-calendar' as const;

const row = (over: Record<string, unknown> = {}) => ({
    provider: PROVIDER,
    grantedAt: new Date('2026-08-19T09:00:00Z'),
    revokedAt: null,
    externalTenantId: 'entra-abc',
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    db.tenantCalendarConsent.upsert.mockResolvedValue(row());
    db.tenantCalendarConsent.updateMany.mockResolvedValue({ count: 1 });
    db.tenantCalendarConsent.findMany.mockResolvedValue([]);
});

describe('only Microsoft uses tenant-wide consent', () => {
    it('Google is per-user and is refused here', async () => {
        // Offering an admin-consent flow for Google would imply a tenant-wide
        // grant that does not exist.
        expect(requiresAdminConsent('google-calendar')).toBe(false);
        await expect(
            recordAdminConsent(ctx, { provider: 'google-calendar' as never, externalTenantId: null }),
        ).rejects.toThrow(/does not use tenant-wide admin consent/);
        expect(db.tenantCalendarConsent.upsert).not.toHaveBeenCalled();
    });

    it('outlook-calendar is', () => {
        expect(requiresAdminConsent(PROVIDER)).toBe(true);
        expect(ADMIN_CONSENT_PROVIDERS).toContain(PROVIDER);
    });
});

describe('granting is audited as an ACCESS event with a named author', () => {
    it('writes detailsJson with category access, not entity_lifecycle', async () => {
        // The row is incidental; the EVENT is that a third party was authorised
        // to reach every user in this tenant. An access review filtering on
        // that category is the reader this exists for.
        await recordAdminConsent(ctx, { provider: PROVIDER, externalTenantId: 'entra-abc' });
        const payload = logEvent.mock.calls[0][2] as unknown as {
            action: string;
            detailsJson: { category: string; operation: string };
        };
        expect(payload.action).toBe('CALENDAR_ADMIN_CONSENT_GRANTED');
        expect(payload.detailsJson.category).toBe('access');
        expect(payload.detailsJson.operation).toBe('grant');
    });

    it('records the granting admin', async () => {
        // grantedByUserId is NOT NULL in the schema: a tenant-wide
        // authorisation with no recorded author is exactly the row an access
        // review cannot act on.
        await recordAdminConsent(ctx, { provider: PROVIDER, externalTenantId: null });
        expect(db.tenantCalendarConsent.upsert.mock.calls[0][0].create.grantedByUserId).toBe('admin-1');
    });

    it('withdrawing is audited too, as a revoke', async () => {
        await revokeAdminConsent(ctx, PROVIDER, 'withdrawn by administrator');
        const payload = logEvent.mock.calls[0][2] as unknown as {
            action: string;
            detailsJson: { category: string; operation: string };
        };
        expect(payload.action).toBe('CALENDAR_ADMIN_CONSENT_REVOKED');
        expect(payload.detailsJson.operation).toBe('revoke');
    });

    it('does NOT audit a withdrawal that changed nothing', async () => {
        // Auditing a no-op teaches a reviewer to ignore the event.
        db.tenantCalendarConsent.updateMany.mockResolvedValue({ count: 0 });
        await revokeAdminConsent(ctx, PROVIDER, 'x');
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('re-granting replaces rather than accumulating', () => {
    it('upserts on (tenantId, provider)', async () => {
        // A second row means two authorisations, one of which nothing revokes.
        await recordAdminConsent(ctx, { provider: PROVIDER, externalTenantId: null });
        expect(db.tenantCalendarConsent.upsert.mock.calls[0][0].where).toEqual({
            tenantId_provider: { tenantId: 't1', provider: PROVIDER },
        });
    });

    it('CLEARS a previous withdrawal — re-authorising is the whole remedy', async () => {
        await recordAdminConsent(ctx, { provider: PROVIDER, externalTenantId: null });
        const update = db.tenantCalendarConsent.upsert.mock.calls[0][0].update;
        expect(update.revokedAt).toBeNull();
        expect(update.revokedReason).toBeNull();
    });

    it('stores the Entra tenant we were ACTUALLY consented in', async () => {
        // Subsequent authorize URLs must use it. Guessing again would send
        // users to an authority where the grant does not exist — and a
        // multi-tenant admin can legitimately consent in a directory we would
        // not have assumed.
        await recordAdminConsent(ctx, { provider: PROVIDER, externalTenantId: 'entra-xyz' });
        expect(db.tenantCalendarConsent.upsert.mock.calls[0][0].create.externalTenantId).toBe('entra-xyz');
    });
});

describe('the state the settings page reads', () => {
    it('reports NOT granted when no row exists — an absence is a real answer', async () => {
        // Making the caller distinguish undefined from not-granted is how that
        // answer gets lost.
        db.tenantCalendarConsent.findMany.mockResolvedValue([]);
        const states = await getConsentStates(ctx);
        expect(states).toHaveLength(ADMIN_CONSENT_PROVIDERS.length);
        expect(states[0]).toMatchObject({ provider: PROVIDER, granted: false, grantedAt: null });
    });

    it('reports granted for a live row', async () => {
        db.tenantCalendarConsent.findMany.mockResolvedValue([row()]);
        expect((await getConsentStates(ctx))[0].granted).toBe(true);
    });

    it('reports NOT granted for a WITHDRAWN row, even though grantedAt is set', async () => {
        // The trap: a caller checking only `grantedAt` would offer Connect
        // after a revocation. `granted` means granted AND not since withdrawn.
        db.tenantCalendarConsent.findMany.mockResolvedValue([
            row({ revokedAt: new Date('2026-08-19T10:00:00Z') }),
        ]);
        const [state] = await getConsentStates(ctx);
        expect(state.granted).toBe(false);
        expect(state.grantedAt).not.toBeNull();
        expect(state.revokedAt).not.toBeNull();
    });

    it('carries the external tenant id through to the caller', async () => {
        db.tenantCalendarConsent.findMany.mockResolvedValue([row()]);
        expect((await getConsentStates(ctx))[0].externalTenantId).toBe('entra-abc');
    });

    it('is bounded by the provider count', async () => {
        await getConsentStates(ctx);
        expect(db.tenantCalendarConsent.findMany.mock.calls[0][0].take).toBe(
            ADMIN_CONSENT_PROVIDERS.length,
        );
    });
});

describe('withdrawing does not touch individual connections', () => {
    it('only updates the consent row', async () => {
        // Their tokens become unrefreshable and the push path already treats a
        // failed refresh as terminal, so each resolves itself with its own
        // recorded reason. A bulk revoke here would produce one
        // indistinguishable mass event and lose every per-user "why".
        await revokeAdminConsent(ctx, PROVIDER, 'withdrawn by administrator');
        expect(Object.keys(db)).toEqual(['tenantCalendarConsent']);
        expect(db.tenantCalendarConsent.updateMany).toHaveBeenCalledTimes(1);
    });

    it('only withdraws a row that is currently live', async () => {
        await revokeAdminConsent(ctx, PROVIDER, 'x');
        expect(db.tenantCalendarConsent.updateMany.mock.calls[0][0].where).toMatchObject({
            revokedAt: null,
        });
    });

    it('caps the reason', async () => {
        await revokeAdminConsent(ctx, PROVIDER, 'y'.repeat(500));
        expect(db.tenantCalendarConsent.updateMany.mock.calls[0][0].data.revokedReason).toHaveLength(200);
    });
});
