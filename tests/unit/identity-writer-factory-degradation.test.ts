/**
 * `resolveDirectoryWriter` — the refusals whose DETAIL an operator has to read.
 *
 * `tests/unit/identity-writer-factory.test.ts` pins the refusal ladder and the
 * DRY_RUN/live split. This file covers what those refusals SAY when the thing
 * that failed was not an `Error`, and what the snapshot reader reports when the
 * observed row is thinner than the happy path assumes.
 *
 * That sounds cosmetic and is not. Every one of these refusals is rendered to
 * an admin on `/admin/identity-leaver-passes` as the only account of why an
 * offboarding pass did nothing, and `String(err)` vs `err.message` is the
 * difference between "auth tag mismatch" and "undefined". A leaver pass that
 * refuses with an empty reason is indistinguishable from a dead worker — the
 * exact failure mode the subsystem's design notes single out.
 *
 * Mocking mirrors the sibling file: `runInTenantContext` runs the callback
 * against a fake db, and `decryptField` is a stub whose throw shape each test
 * chooses.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
const decrypt = jest.fn();
jest.mock('@/lib/security/encryption', () => ({
    decryptField: (v: string) => decrypt(v),
}));
const createEntra = jest.fn();
const createAd = jest.fn();
jest.mock('@/app-layer/integrations/providers/entra-id/writer', () => ({
    createEntraIdWriter: (...a: unknown[]) => createEntra(...a),
}));
jest.mock('@/app-layer/integrations/providers/active-directory/writer', () => ({
    createActiveDirectoryWriter: (...a: unknown[]) => createAd(...a),
}));

import {
    resolveDirectoryWriter,
    createSnapshotWriter,
} from '@/app-layer/integrations/identity-writer-factory';
import { logger } from '@/lib/observability/logger';
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {
    integrationConnection: { findMany: jest.fn() },
    connectedIdentityAccount: { findFirst: jest.fn() },
};

const ctx = makeRequestContext('ADMIN', { tenantId: 't1' });

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockImplementation((v: string) => v);
    mockDb.integrationConnection.findMany.mockResolvedValue([
        { id: 'conn-1', configJson: { url: 'ldaps://dc.corp.internal' }, secretEncrypted: null },
    ]);
    createEntra.mockReturnValue({ provider: 'entra-id' });
    createAd.mockReturnValue({ provider: 'active-directory', close: jest.fn(async () => undefined) });
});

describe('a refusal always carries a readable reason, even for a non-Error throw', () => {
    it('SECRETS_UNREADABLE stringifies a thrown non-Error into the detail', async () => {
        // A KMS client or a native binding can reject with a plain string. If
        // that landed as `undefined`, the admin page would show a refusal with
        // no cause — which reads as the pass having found nothing to do.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: {}, secretEncrypted: 'BAD' },
        ]);
        // eslint-disable-next-line no-throw-literal -- deliberately not an Error
        decrypt.mockImplementation(() => { throw 'DEK unavailable'; });

        const r = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });

        expect(r.kind).toBe('none');
        if (r.kind !== 'none') return;
        expect(r.refusal).toBe('SECRETS_UNREADABLE');
        expect(r.detail).toContain('DEK unavailable');
    });

    it('WRITER_REFUSED stringifies a non-Error thrown by the constructor', async () => {
        // eslint-disable-next-line no-throw-literal -- deliberately not an Error
        createAd.mockImplementation(() => { throw 'ldap bind rejected'; });

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });

        expect(r).toMatchObject({ kind: 'none', refusal: 'WRITER_REFUSED', detail: 'ldap bind rejected' });
        // The refusal is also logged, because the admin page shows the detail
        // but not which of the two constructor arms produced it.
        expect(logger.warn).toHaveBeenCalledWith(
            'directory writer could not be constructed',
            expect.objectContaining({ refusal: 'WRITER_REFUSED', provider: 'active-directory' }),
        );
    });

    it('a dry run whose secrets throw a non-Error still degrades to config-only', async () => {
        // The DRY_RUN arm catches around `mergeConnection` and falls back to
        // configJson. A non-Error throw must take the same fallback — throwing
        // out of here would turn "one bind protected instead of two" into "no
        // observation window at all", during the seven days a tenant is
        // REQUIRED to observe.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: { bindDN: 'CN=svc-read,DC=corp' }, secretEncrypted: 'BAD' },
        ]);
        // eslint-disable-next-line no-throw-literal -- deliberately not an Error
        decrypt.mockImplementation(() => { throw 'DEK unavailable'; });

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual(['CN=svc-read,DC=corp']);
        expect(logger.warn).toHaveBeenCalledWith(
            'dry-run self-account ids fell back to config: secrets did not decrypt',
            expect.objectContaining({ error: 'DEK unavailable' }),
        );
    });

    it('a connection with NO configJson at all still yields a snapshot, protecting no bind', async () => {
        // `configJson ?? {}`. A null column must read as "no binds declared",
        // which refuses nothing on the self-lockout ground — not as a crash
        // that ends the pass.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: null, secretEncrypted: 'BAD' },
        ]);
        decrypt.mockImplementation(() => { throw new Error('auth tag mismatch'); });

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual([]);
    });

    it('merges the decrypted write bind ahead of the config read bind', async () => {
        // Both binds, in that order — a dedicated write bind does not make the
        // read bind expendable, since disabling it stops the nightly sync and
        // stales every link.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            {
                id: 'c1',
                configJson: { bindDN: 'CN=svc-read,DC=corp' },
                secretEncrypted: JSON.stringify({ writeBindDN: 'CN=svc-write,DC=corp' }),
            },
        ]);

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual(['CN=svc-write,DC=corp', 'CN=svc-read,DC=corp']);
    });

    it('a connection with no secret column at all merges to config alone', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: null, secretEncrypted: null },
        ]);

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual([]);
        expect(decrypt).not.toHaveBeenCalled();
    });
});

describe('the snapshot reader survives a thin observed row', () => {
    it('reports observedAt as null when the row carries no updatedAt', async () => {
        // `row.updatedAt?.toISOString?.() ?? null`. Both optionals are load-
        // bearing: this bag is written verbatim into a journal `priorState`,
        // and a throw here would fail the whole dry run for one incomplete row
        // rather than reporting that row as unobserved.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'ACTIVE',
            updatedAt: null,
            onPremisesSyncEnabled: undefined,
            onPremStateObservedAt: null,
        });

        const state = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');

        expect(state.enabled).toBe(true);
        expect(state.priorState).toMatchObject({
            source: 'SNAPSHOT',
            observedAt: null,
            // Absent maps to null, never to `undefined` — `undefined` would
            // vanish on JSON round-trip and read as "column not selected".
            onPremisesSyncEnabled: null,
            onPremStateObserved: false,
            staleEvidence: true,
        });
    });
});
