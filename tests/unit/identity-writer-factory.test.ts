/**
 * One seam from a connection to a writer — and what it refuses.
 *
 * The load-bearing assertion in here is that DRY_RUN never constructs a real
 * writer. `decideAndDisable` reads state BEFORE it consults the mode, so an
 * observation pass would otherwise have to build a live Entra writer — whose
 * constructor demands `writesEnabled`, the very flag the ladder exists to
 * withhold until a tenant has watched a dry run. Requiring it in order to
 * observe would invert the ladder; forcing it on inside the factory would route
 * around a control by pretending to satisfy it.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn((v: string) => {
        if (v === 'BROKEN') throw new Error('auth tag mismatch');
        return v;
    }),
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
    isWritableIdentityProvider,
} from '@/app-layer/integrations/identity-writer-factory';
import { DirectoryWriteError } from '@/app-layer/usecases/identity-disable-account';
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {
    integrationConnection: { findMany: jest.fn() },
    connectedIdentityAccount: { findFirst: jest.fn() },
};

const ctx = makeRequestContext('ADMIN', { tenantId: 't1' });

function conn(over: Record<string, unknown> = {}) {
    return { id: 'conn-1', configJson: { url: 'ldaps://dc.corp.internal' }, secretEncrypted: null, ...over };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findMany.mockResolvedValue([conn()]);
    mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
        status: 'ACTIVE',
        updatedAt: new Date('2026-08-20T03:00:00.000Z'),
        onPremisesSyncEnabled: false,
    });
    createEntra.mockReturnValue({ provider: 'entra-id' });
    createAd.mockReturnValue({ provider: 'active-directory', close: jest.fn(async () => undefined) });
});

describe('DRY_RUN never touches the directory', () => {
    it.each(['entra-id', 'active-directory'])('resolves a snapshot reader for %s', async (provider) => {
        const r = await resolveDirectoryWriter({ ctx, provider, mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        // The proof: neither real writer was constructed, so no consent is
        // needed to observe and no Graph token is minted.
        expect(createEntra).not.toHaveBeenCalled();
        expect(createAd).not.toHaveBeenCalled();
    });

    it('reads the connection, but constructs no writer from it', async () => {
        // CHANGED DELIBERATELY. This used to assert the connection was never
        // read at all, and that assertion is what kept the self-lockout refusal
        // inert in the only mode anyone runs: with no connection there is no
        // bind identity, so `createSnapshotWriter` hardcoded null and the guard
        // had nothing to compare against.
        //
        // The argument for withholding a live writer from a dry run was never
        // about the READ — it is about the CONSTRUCTOR. `createEntraIdWriter`
        // refuses unless writesEnabled === true, and requiring that flag in
        // order to run the observation rung would invert the whole ladder. That
        // is what the two assertions below protect, and they are unchanged.
        await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'DRY_RUN' });
        expect(mockDb.integrationConnection.findMany).toHaveBeenCalled();
        expect(createEntra).not.toHaveBeenCalled();
        expect(createAd).not.toHaveBeenCalled();
    });

    it('carries both configured binds into the snapshot reader', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: { bindDN: 'CN=svc-read,DC=corp' }, secretEncrypted: null },
        ]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual(['CN=svc-read,DC=corp']);
    });

    it('DOES refuse NO_CONNECTION in DRY_RUN — reversed deliberately in phase 2', async () => {
        // This test asserted the OPPOSITE one release ago, and the reversal is
        // the point rather than a regression.
        //
        // Phase 1's reasoning was sound for phase 1: the snapshot reader answered
        // from stored rows, so it could still observe usefully with zero
        // connections, and refusing would have stopped a tenant observing during
        // seven days it is REQUIRED to observe.
        //
        // Phase 2 makes that false. `connectionId` is NOT NULL and an account is
        // keyed (tenantId, connectionId, externalUserId), so the reader needs one
        // connection to scope by. With none there are no account rows either — a
        // row exists because a connection's sync created it — so every candidate
        // would come back "no observed directory record": a FAILED per account
        // instead of one named refusal for the run. And since #2066 the refusal
        // is RECORDED, so it appears in the seven-day artefact rather than being
        // silence.
        mockDb.integrationConnection.findMany.mockResolvedValue([]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'DRY_RUN' });

        expect(r.kind).toBe('none');
        if (r.kind !== 'none') return;
        expect(r.refusal).toBe('NO_CONNECTION');
    });

    it('still DEGRADES rather than refuses when the secrets will not decrypt', async () => {
        // The other half of phase 1's argument survives intact, and this is the
        // line that proves the reversal above was scoped rather than wholesale:
        // SECRETS_UNREADABLE stays BELOW the dry-run arm, so an undecryptable
        // secret still yields a dry run with the config-only bind protected
        // instead of no dry run at all.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', configJson: { bindDN: 'CN=svc-read,DC=corp' }, secretEncrypted: 'BROKEN' },
        ]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual(['CN=svc-read,DC=corp']);
    });

    it('keeps observing when the secrets will not decrypt, with what config alone can say', async () => {
        // A DEK failure must degrade the dry run, not end it: bindDN is a config
        // field and needs no decryption, so one bind is still protected. The
        // LIVE path still refuses SECRETS_UNREADABLE by name — that judgement is
        // made below, where a real write is at stake.
        mockDb.integrationConnection.findMany.mockResolvedValue([
            // 'BROKEN' is what this file's decryptField mock throws on.
            { id: 'c1', configJson: { bindDN: 'CN=svc-read,DC=corp' }, secretEncrypted: 'BROKEN' },
        ]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'DRY_RUN' });

        expect(r.kind).toBe('snapshot');
        if (r.kind !== 'snapshot') return;
        expect(r.writer.selfAccountIds).toEqual(['CN=svc-read,DC=corp']);
    });
});

describe('the snapshot reader', () => {
    it('SCOPES its read to the connection, not just the provider', () => {
        // Phase 2 keys an account on (tenantId, connectionId, externalUserId), so
        // the same externalUserId can legitimately exist under two connections —
        // two forests, two rows, two different accounts. Reading by provider alone
        // would return whichever Prisma ordered first, and a dry run would report
        // a decision about the wrong directory.
        return createSnapshotWriter(ctx, 'active-directory', 'conn-9')
            .readState('ext-1')
            .then(() => {
                const where = mockDb.connectedIdentityAccount.findFirst.mock.calls.at(-1)![0].where;
                expect(where).toMatchObject({
                    tenantId: 't1',
                    provider: 'active-directory',
                    connectionId: 'conn-9',
                    externalUserId: 'ext-1',
                });
            });
    });

    it('reports enabled from the observed status, for both writable providers', async () => {
        const w = createSnapshotWriter(ctx, 'entra-id', 'conn-1');
        expect((await w.readState('ext-1')).enabled).toBe(true);

        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'SUSPENDED',
            updatedAt: new Date(),
            onPremisesSyncEnabled: false,
        });
        expect((await w.readState('ext-1')).enabled).toBe(false);
    });

    it('treats DEPROVISIONED as not enabled, matching the live writer on a 404', async () => {
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'DEPROVISIONED',
            updatedAt: new Date(),
            onPremisesSyncEnabled: null,
        });
        expect((await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1')).enabled).toBe(false);
    });

    it('answers the on-prem observation question, like the live capture does', async () => {
        // PARITY, and it is about a gate that cannot fire here YET.
        // `EntraIdDirectoryWriter.disable` refuses on
        // `priorState.onPremStateObserved !== true`. That check is unreachable in
        // DRY_RUN only because the usecase returns before `writer.disable` — and
        // the writer's own header says decisions that need no network belong
        // ABOVE that line, so hoisting it is the obvious next edit. If this bag
        // lacked the key when that happened, `!== true` would be satisfied by
        // ABSENCE and every dry-run candidate would refuse, inverting the
        // observation window with nothing failing.
        //
        // `priorState` is a Record<string, unknown>, so this assertion is the
        // only thing making the two captures agree.
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'ACTIVE',
            updatedAt: new Date(),
            onPremisesSyncEnabled: null,
            // RELATIVE. Inert while the capture answers on presence
            // (`identity-writer-factory.ts:197` is `!= null`), and a fuse the
            // moment anyone makes it answer on age.
            onPremStateObservedAt: new Date(Date.now() - 60 * 60 * 1000),
        });
        const observed = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');
        expect(observed.priorState).toMatchObject({ onPremStateObserved: true });

        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue({
            status: 'ACTIVE',
            updatedAt: new Date(),
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: null,
        });
        const unobserved = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');
        expect(unobserved.priorState).toMatchObject({ onPremStateObserved: false });
    });

    it('marks its evidence stale, so nothing settles a journal row from it', async () => {
        // Settling INDETERMINATE -> APPLIED asserts "our earlier write landed",
        // inferred from the account being disabled NOW. Sound from a live read;
        // unsound from data up to a day old — an account re-enabled this
        // morning still reads SUSPENDED in last night's snapshot.
        const state = await createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ext-1');
        expect(state.priorState).toMatchObject({ source: 'SNAPSHOT', staleEvidence: true });
    });

    it('refuses an account the last complete sync never saw', async () => {
        mockDb.connectedIdentityAccount.findFirst.mockResolvedValue(null);
        await expect(createSnapshotWriter(ctx, 'entra-id', 'conn-1').readState('ghost')).rejects.toBeInstanceOf(
            DirectoryWriteError,
        );
    });

    it('THROWS on disable rather than quietly doing nothing', async () => {
        // A silent no-op would make a mode bug — a pass above DRY_RUN handed the
        // observation writer — look exactly like a successful dry run.
        const err = await createSnapshotWriter(ctx, 'entra-id', 'conn-1')
            .disable('ext-1', { enabled: true, priorState: {} })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });
});

describe('refusals, cheapest first', () => {
    it('refuses a provider that has no writer, without reading anything', async () => {
        const r = await resolveDirectoryWriter({ ctx, provider: 'okta', mode: 'AUTOMATIC' });
        expect(r).toMatchObject({ kind: 'none', refusal: 'UNSUPPORTED_PROVIDER' });
        expect(mockDb.integrationConnection.findMany).not.toHaveBeenCalled();
    });

    it('refuses when no enabled connection exists', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });
        expect(r).toMatchObject({ kind: 'none', refusal: 'NO_CONNECTION' });
    });

    it('refuses TWO enabled connections rather than picking one', async () => {
        // A directory account carries no connectionId, so with two forests there
        // is no way to say which one an account belongs to.
        mockDb.integrationConnection.findMany.mockResolvedValue([conn(), conn({ id: 'conn-2' })]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });
        expect(r).toMatchObject({ kind: 'none', refusal: 'AMBIGUOUS_CONNECTION' });
        expect(createAd).not.toHaveBeenCalled();
    });

    it('refuses by name when the secrets do not decrypt', async () => {
        mockDb.integrationConnection.findMany.mockResolvedValue([conn({ secretEncrypted: 'BROKEN' })]);
        const r = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });
        // Not a `catch → {}`: an empty secret bag builds a writer that fails
        // once per account with nothing said about why.
        expect(r).toMatchObject({ kind: 'none', refusal: 'SECRETS_UNREADABLE' });
    });

    it('names a writes-not-enabled connection distinctly from a broken one', async () => {
        createEntra.mockImplementation(() => {
            throw new Error('Entra writer refused: this connection is not enabled for directory writes.');
        });
        const r = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });
        expect(r).toMatchObject({ kind: 'none', refusal: 'WRITES_NOT_ENABLED' });
    });

    it('falls back to WRITER_REFUSED for any other constructor refusal', async () => {
        createAd.mockImplementation(() => {
            throw new Error('The URL must use ldaps:// (LDAP over TLS).');
        });
        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });
        expect(r).toMatchObject({ kind: 'none', refusal: 'WRITER_REFUSED' });
    });
});

describe('disposal is in the type, not in a convention', () => {
    it('gives every resolution a close(), so the caller’s finally is unconditional', async () => {
        const dry = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'DRY_RUN' });
        const entra = await resolveDirectoryWriter({ ctx, provider: 'entra-id', mode: 'AUTOMATIC' });
        const ad = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });

        for (const r of [dry, entra, ad]) {
            expect(r.kind).not.toBe('none');
            if (r.kind !== 'none') await expect(r.close()).resolves.toBeUndefined();
        }
    });

    it('closes the real LDAP socket for the live AD arm', async () => {
        const closed = jest.fn(async () => undefined);
        createAd.mockReturnValue({ provider: 'active-directory', close: closed });

        const r = await resolveDirectoryWriter({ ctx, provider: 'active-directory', mode: 'AUTOMATIC' });
        if (r.kind !== 'none') await r.close();

        expect(closed).toHaveBeenCalledTimes(1);
    });
});

describe('the provider allowlist', () => {
    it.each([
        ['entra-id', true],
        ['active-directory', true],
        ['okta', false],
        ['google-workspace', false],
    ])('%s writable = %s', (p, expected) => {
        expect(isWritableIdentityProvider(p)).toBe(expected);
    });
});
