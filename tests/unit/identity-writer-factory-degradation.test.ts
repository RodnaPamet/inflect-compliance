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

describe('the snapshot bag survives a row thinner than the happy path assumes', () => {
    // WHAT IS AND IS NOT REACHABLE HERE. The comment this block used to carry
    // said "both optionals are load-bearing" about
    // `row.updatedAt?.toISOString?.() ?? null`, and that was wrong twice over.
    // `ConnectedIdentityAccount.updatedAt` is `DateTime @updatedAt` — NOT NULL
    // — so a row read through Prisma always carries a Date and NEITHER optional
    // fires on production data.
    //
    // They are not therefore untestable, but the claim has to shrink to what is
    // true. What they defend against is the shape of the row, and the row's
    // shape is set by the `select` two edits away in the same file:
    //
    //   · drop a column from that `select` and the field arrives `undefined`
    //     — the first optional and the `?? null` turn that into a key that
    //     still exists and still says null, instead of one that disappears on
    //     the JSON round-trip into `priorState`;
    //   · the second optional (`toISOString?.`) fires only for a row whose
    //     `updatedAt` is not a Date, which no Prisma read produces. It is
    //     pinned below as a DEGRADATION contract — readState must not throw
    //     for one malformed row, because a throw here fails the entire
    //     dry-run pass — and NOT as an observed production state.
    //
    // The `onPremStateObserved` true/false pair is deliberately not repeated
    // here; the sibling suite already carries it.

    it('renders a real observation timestamp as an ISO string', async () => {
        // The production shape — the only row in this block that Prisma can
        // actually return. ISO rather than `.toString()` because the bag is
        // stored as JSON on a journal row and read back by another process,
        // where a locale-formatted date is not a timestamp.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'SUSPENDED',
            updatedAt: new Date('2026-08-20T03:00:00.000Z'),
            onPremisesSyncEnabled: false,
            onPremStateObservedAt: new Date('2026-08-20T03:00:00.000Z'),
        });

        const state = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');

        expect(state.enabled).toBe(false);
        expect(state.priorState).toMatchObject({
            source: 'SNAPSHOT',
            observedStatus: 'SUSPENDED',
            observedAt: '2026-08-20T03:00:00.000Z',
            onPremisesSyncEnabled: false,
        });
    });

    it('a column dropped from the select reports null, not a key that vanishes', async () => {
        // Both fields absent, which is what the row looks like the day someone
        // trims the `select` above. `?? null` is what keeps the two keys in the
        // bag: `undefined` does not survive `JSON.stringify`, so the journal
        // row would come back missing them entirely and read as "this product
        // never selected the column" rather than "the directory had no answer".
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'ACTIVE',
            onPremStateObservedAt: null,
        });

        const state = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');
        const roundTripped = JSON.parse(JSON.stringify(state.priorState)) as Record<string, unknown>;

        expect(Object.keys(roundTripped)).toEqual(expect.arrayContaining(['observedAt', 'onPremisesSyncEnabled']));
        expect(roundTripped.observedAt).toBeNull();
        expect(roundTripped.onPremisesSyncEnabled).toBeNull();
    });

    it('a row whose updatedAt is not a Date degrades to null instead of throwing', async () => {
        // The SECOND optional in `row.updatedAt?.toISOString?.()`, and this
        // test claims exactly one thing: readState answers for a malformed row
        // rather than throwing out of it. It is not evidence that any caller
        // produces this row — `updatedAt` is NOT NULL and Prisma hydrates it as
        // a Date, so nothing in the product does today.
        //
        // Worth pinning anyway because of where the throw would land. readState
        // runs once per leaver CANDIDATE inside the dry-run pass; an exception
        // is not scoped to the row that caused it, so one row carrying a
        // string where a Date belongs would end the observation window for the
        // whole tenant — during the seven days the ladder REQUIRES a tenant to
        // observe before it may leave DRY_RUN.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'ACTIVE',
            // A string, i.e. what a Date becomes across any JSON boundary.
            updatedAt: '2026-08-20T03:00:00.000Z',
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: null,
        });

        const state = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');

        expect(state.enabled).toBe(true);
        expect(state.priorState).toMatchObject({ source: 'SNAPSHOT', observedAt: null });
    });
});
