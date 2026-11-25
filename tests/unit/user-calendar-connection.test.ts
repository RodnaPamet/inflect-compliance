/**
 * The calendar-connection usecase: what it hands the encryption layer, what it
 * audits, and what it refuses.
 *
 * Encryption itself is the Epic B extension's (the column is in
 * `ENCRYPTED_FIELDS`, under the tenant's DEK). This suite proves the usecase's
 * half of that contract against the REAL manifest: it writes one JSON blob to
 * exactly the manifest column, never seals it a second time with the global key,
 * and refuses to parse a value the extension could not decrypt. The integration
 * suite `tests/integration/user-calendar-token-tenant-key.test.ts` proves the
 * ciphertext on disk is `v2:` and that a `v1:` row still reads.
 *
 * The revoke-keeps-the-row property is the one that reads as a bug and is not.
 * The row is the ONLY local record that events were ever pushed under this
 * connection; deleting it strands whatever is already in the user's personal
 * calendar with nothing left to name it.
 */
const encryptField = jest.fn((v: string) => `v1:enc(${v})`);

jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    encryptField: (v: string) => encryptField(v),
}));

const logEvent = jest.fn(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

const db = {
    userCalendarConnection: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

import {
    saveCalendarConnection,
    readCalendarToken,
    updateCalendarToken,
    revokeCalendarConnection,
    listCalendarConnections,
    recordCalendarConnectFailure,
    isCalendarProviderId,
    CALENDAR_PROVIDERS,
} from '@/app-layer/usecases/user-calendar-connection';
import { makeRequestContext } from '../helpers/make-context';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

const ctx = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });
const TOKEN = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1_800_000_000 };

const row = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1',
    provider: 'google-calendar',
    connectedAt: new Date('2026-08-01'),
    revokedAt: null,
    revokedReason: null,
    lastPushedAt: null,
    scopesGranted: ['calendar.events'],
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    db.userCalendarConnection.upsert.mockResolvedValue(row());
    db.userCalendarConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe('the token is sealed by the manifest, under the tenant key', () => {
    it('the column is in the Epic B manifest — the thing that puts it in both rotation sweeps', () => {
        // Both `jobs/key-rotation.ts` and `jobs/tenant-dek-rotation.ts` iterate
        // ENCRYPTED_FIELDS. Off the manifest, the column is in neither sweep.
        expect(ENCRYPTED_FIELDS.UserCalendarConnection).toEqual(['tokenEncrypted']);
    });

    it('writes the whole payload as ONE JSON blob to that column, and seals nothing itself', async () => {
        // One blob, not three columns: a partial write cannot leave a refresh
        // token stranded without the expiry that says when to use it. And no
        // explicit `encryptField`: that is the GLOBAL key (`v1:`), which the
        // extension would then skip as already encrypted — the token would
        // never reach the tenant key.
        await saveCalendarConnection(ctx, {
            provider: 'google-calendar',
            token: TOKEN,
            scopesGranted: ['calendar.events'],
        });
        const call = db.userCalendarConnection.upsert.mock.calls[0][0];
        expect(JSON.parse(call.create.tokenEncrypted)).toEqual(TOKEN);
        expect(JSON.parse(call.update.tokenEncrypted)).toEqual(TOKEN);
        expect(encryptField).not.toHaveBeenCalled();
    });

    it('a refreshed token is written the same way — the write that moves an old v1 row onto the tenant key', async () => {
        await updateCalendarToken(ctx, 'google-calendar', TOKEN);
        expect(JSON.parse(db.userCalendarConnection.updateMany.mock.calls[0][0].data.tokenEncrypted)).toEqual(TOKEN);
        expect(encryptField).not.toHaveBeenCalled();
    });

    it('reads back the payload the extension decrypted', async () => {
        db.userCalendarConnection.findUnique.mockResolvedValue({
            id: 'conn-1',
            tokenEncrypted: JSON.stringify(TOKEN),
            revokedAt: null,
        });
        const got = await readCalendarToken(ctx, 'google-calendar');
        expect(got?.token).toEqual(TOKEN);
    });

    it.each(['v1:', 'v2:'])('REFUSES a %s value the extension could not decrypt, without quoting it', async (prefix) => {
        // A read outside a tenant context (a bypass source) gets the ciphertext
        // back. Parsing it would throw an error quoting it; using it would be
        // worse.
        db.userCalendarConnection.findUnique.mockResolvedValue({
            id: 'conn-1',
            tokenEncrypted: `${prefix}c2VjcmV0LWNpcGhlcnRleHQ=`,
            revokedAt: null,
        });
        const err = await readCalendarToken(ctx, 'google-calendar').catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/could not be decrypted/);
        expect((err as Error).message).not.toContain('c2VjcmV0');
    });

    it('the summary the settings surface gets carries no token field at all', async () => {
        db.userCalendarConnection.findMany.mockResolvedValue([row()]);
        const [summary] = await listCalendarConnections(ctx);
        expect(summary).not.toHaveProperty('tokenEncrypted');
    });
});

describe('connects are audited, without the credential', () => {
    it('a saved connection writes CALENDAR_CONNECTED naming the provider, never the token', async () => {
        await saveCalendarConnection(ctx, { provider: 'outlook-calendar', token: TOKEN, scopesGranted: ['a', 'b'] });
        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
        expect(payload.action).toBe('CALENDAR_CONNECTED');
        expect(payload.metadata).toEqual({ provider: 'outlook-calendar', scopeCount: 2 });
        expect(JSON.stringify(payload)).not.toContain('"rt"');
        expect(JSON.stringify(payload)).not.toContain('"at"');
    });

    it('a failed connect writes CALENDAR_CONNECT_FAILED with the outcome, and drops a provider code that is not OAuth-shaped', async () => {
        await recordCalendarConnectFailure(ctx, {
            provider: 'google-calendar',
            outcome: 'provider_error',
            providerErrorCode: 'Bad thing for jane@example.com',
        });
        const payload = (logEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
        expect(payload.action).toBe('CALENDAR_CONNECT_FAILED');
        expect(payload.metadata).toEqual({ provider: 'google-calendar', outcome: 'provider_error', providerErrorCode: undefined });
        expect(JSON.stringify(payload)).not.toContain('jane@example.com');
    });

    it('keeps an OAuth error code', async () => {
        await recordCalendarConnectFailure(ctx, { provider: 'google-calendar', outcome: 'connect_declined', providerErrorCode: 'access_denied' });
        const payload = (logEvent.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
        expect(payload.metadata).toMatchObject({ providerErrorCode: 'access_denied' });
    });
});

describe('consent without a refresh token is refused', () => {
    it('throws BEFORE writing anything', async () => {
        // Without a refresh token the connection works until the first expiry
        // and then dies silently overnight. Fail while the user is present and
        // can re-run consent, not at 04:00 in a job nobody watches.
        await expect(
            saveCalendarConnection(ctx, {
                provider: 'google-calendar',
                token: { ...TOKEN, refreshToken: '' },
                scopesGranted: [],
            }),
        ).rejects.toThrow(/refresh token/i);
        expect(db.userCalendarConnection.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('an unknown provider is refused before any write', async () => {
        await expect(
            saveCalendarConnection(ctx, {
                provider: 'fantasy-calendar' as never,
                token: TOKEN,
                scopesGranted: [],
            }),
        ).rejects.toThrow(/Unknown calendar provider/);
        expect(db.userCalendarConnection.upsert).not.toHaveBeenCalled();
    });

    it('isCalendarProviderId gates on the real list', () => {
        for (const p of CALENDAR_PROVIDERS) expect(isCalendarProviderId(p)).toBe(true);
        expect(isCalendarProviderId('google')).toBe(false);
        expect(isCalendarProviderId('')).toBe(false);
    });
});

describe('re-consent replaces rather than accumulates', () => {
    it('upserts on (tenantId, userId, provider)', async () => {
        // A second row for the same triple means two tokens, one of which
        // nothing refreshes and nothing revokes.
        await saveCalendarConnection(ctx, { provider: 'google-calendar', token: TOKEN, scopesGranted: [] });
        expect(db.userCalendarConnection.upsert.mock.calls[0][0].where).toEqual({
            tenantId_userId_provider: { tenantId: 't1', userId: 'u1', provider: 'google-calendar' },
        });
    });

    it('CLEARS a previous revocation — reconnecting is the whole remedy', async () => {
        // Leaving revokedAt set would keep showing the user an error they have
        // already fixed.
        await saveCalendarConnection(ctx, { provider: 'google-calendar', token: TOKEN, scopesGranted: [] });
        const update = db.userCalendarConnection.upsert.mock.calls[0][0].update;
        expect(update.revokedAt).toBeNull();
        expect(update.revokedReason).toBeNull();
    });
});

describe('revoke destroys the credential and keeps the row', () => {
    it('overwrites the ciphertext and stamps the reason', async () => {
        // Once consent is gone the ciphertext is a credential we can no longer
        // use and no longer need; keeping it only widens what a database
        // compromise yields.
        await revokeCalendarConnection(ctx, 'google-calendar', 'consent withdrawn');
        const data = db.userCalendarConnection.updateMany.mock.calls[0][0].data;
        expect(data.tokenEncrypted).toBe('');
        expect(data.revokedAt).toBeInstanceOf(Date);
        expect(data.revokedReason).toBe('consent withdrawn');
    });

    it('does NOT delete — the row is the only record events were pushed', async () => {
        await revokeCalendarConnection(ctx, 'google-calendar', 'x');
        expect(db.userCalendarConnection).not.toHaveProperty('delete.mock.calls.length', 1);
        expect(db.userCalendarConnection.updateMany).toHaveBeenCalled();
    });

    it('caps the reason so a provider body cannot be pasted in whole', async () => {
        await revokeCalendarConnection(ctx, 'google-calendar', 'y'.repeat(500));
        expect(db.userCalendarConnection.updateMany.mock.calls[0][0].data.revokedReason).toHaveLength(200);
    });

    it('throws when there is nothing to revoke', async () => {
        db.userCalendarConnection.updateMany.mockResolvedValue({ count: 0 });
        await expect(revokeCalendarConnection(ctx, 'google-calendar', 'x')).rejects.toThrow();
    });
});

describe('a revoked connection is invisible to the push path', () => {
    it('readCalendarToken returns null rather than throwing', async () => {
        // The fan-out visits many users; one revoked token must not abort the
        // batch for everyone else.
        db.userCalendarConnection.findUnique.mockResolvedValue({
            id: 'conn-1', tokenEncrypted: '', revokedAt: new Date(),
        });
        expect(await readCalendarToken(ctx, 'google-calendar')).toBeNull();
    });

    it('returns null when there is no connection at all', async () => {
        db.userCalendarConnection.findUnique.mockResolvedValue(null);
        expect(await readCalendarToken(ctx, 'google-calendar')).toBeNull();
    });

    it('a rotated token is NOT written back onto a revoked connection', async () => {
        // A refresh already in flight when consent was withdrawn must not
        // resurrect the connection with a fresh token.
        await updateCalendarToken(ctx, 'google-calendar', TOKEN);
        expect(db.userCalendarConnection.updateMany.mock.calls[0][0].where).toMatchObject({
            revokedAt: null,
        });
    });
});
