/**
 * The calendar-connection usecase: what it encrypts, and what it refuses.
 *
 * The integration suite proves the DATABASE isolates these rows. This proves
 * the layer above it — that the token is never written in the clear, that a
 * consent without a refresh token is refused at the moment the user is present
 * to fix it, and that revoking destroys the credential while keeping the row.
 *
 * The revoke-keeps-the-row property is the one that reads as a bug and is not.
 * The row is the ONLY local record that events were ever pushed under this
 * connection; deleting it strands whatever is already in the user's personal
 * calendar with nothing left to name it.
 */
const encryptField = jest.fn((v: string) => `enc(${v})`);
const decryptField = jest.fn((v: string) => v.replace(/^enc\(([\s\S]*)\)$/, '$1'));

jest.mock('@/lib/security/encryption', () => ({
    encryptField: (v: string) => encryptField(v),
    decryptField: (v: string) => decryptField(v),
}));

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
    isCalendarProviderId,
    CALENDAR_PROVIDERS,
} from '@/app-layer/usecases/user-calendar-connection';
import { makeRequestContext } from '../helpers/make-context';

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

describe('the token is never stored in the clear', () => {
    it('encrypts the whole payload as ONE blob', async () => {
        // One blob, not three columns: a partial write cannot leave a refresh
        // token stranded without the expiry that says when to use it — the
        // state that looks connected and silently never refreshes.
        await saveCalendarConnection(ctx, {
            provider: 'google-calendar',
            token: TOKEN,
            scopesGranted: ['calendar.events'],
        });
        expect(encryptField).toHaveBeenCalledWith(JSON.stringify(TOKEN));
        const call = db.userCalendarConnection.upsert.mock.calls[0][0];
        expect(call.create.tokenEncrypted).toBe(`enc(${JSON.stringify(TOKEN)})`);
        // The plaintext must appear nowhere in what is written.
        expect(JSON.stringify(call)).not.toContain('"rt"');
    });

    it('round-trips through decryptField on read', async () => {
        db.userCalendarConnection.findUnique.mockResolvedValue({
            id: 'conn-1',
            tokenEncrypted: `enc(${JSON.stringify(TOKEN)})`,
            revokedAt: null,
        });
        const got = await readCalendarToken(ctx, 'google-calendar');
        expect(got?.token).toEqual(TOKEN);
        expect(decryptField).toHaveBeenCalled();
    });

    it('the summary the settings surface gets carries no token field at all', async () => {
        db.userCalendarConnection.findMany.mockResolvedValue([row()]);
        const [summary] = await listCalendarConnections(ctx);
        expect(summary).not.toHaveProperty('tokenEncrypted');
        expect(JSON.stringify(summary)).not.toContain('enc(');
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
        expect(encryptField).not.toHaveBeenCalled();
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
