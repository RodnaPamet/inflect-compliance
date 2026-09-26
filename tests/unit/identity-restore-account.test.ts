/**
 * #2877 finding 26 — putting back what a disable replaced.
 *
 * ═══ WHAT MAKES THIS SAFE TO HAVE AT ALL ═══
 *
 * `DirectoryWriter` declared no enable verb for a long time, deliberately:
 * re-enabling accounts in a customer's directory is a capability to choose on
 * purpose, not to acquire as a side effect of closing a finding. What is added
 * is not an enable. It writes one specific captured value and refuses unless
 * the account is still exactly as this product left it — so it can only undo
 * something this product did and can still prove it did.
 *
 * These tests pin the orchestration around that verb. The compare-and-swap
 * itself lives in the writers and is tested there; what matters here is that
 * the capture is committed BEFORE the write, that the original row is settled
 * REVERTED only AFTER the write lands, and that every refusal is a named
 * outcome rather than a thrown surprise.
 */
const mockLookup = jest.fn();
const mockBeginWrite = jest.fn();
const mockSettleReverted = jest.fn();
jest.mock('@/app-layer/usecases/identity-write-journal', () => ({
    getRestorableStateForAccount: (...a: unknown[]) => mockLookup(...a),
    beginWrite: (...a: unknown[]) => mockBeginWrite(...a),
    settleReverted: (...a: unknown[]) => mockSettleReverted(...a),
}));

const mockResolveWriter = jest.fn();
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    resolveDirectoryWriter: (...a: unknown[]) => mockResolveWriter(...a),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { restoreAccount } from '@/app-layer/usecases/identity-restore-account';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 't1', userId: 'u1' });

const applied = jest.fn();
const failed = jest.fn();
const indeterminate = jest.fn();
const restore = jest.fn();
const close = jest.fn();

function foundCapture(over: Record<string, unknown> = {}) {
    return {
        kind: 'found',
        accountId: 'acc-1',
        provider: 'active-directory',
        externalUserId: 'guid-9',
        journalId: 'jrn-old',
        priorState: { userAccountControl: 512 },
        attemptedAt: new Date('2026-09-12T05:00:00.000Z'),
        outcome: 'APPLIED',
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockResolvedValue(foundCapture());
    mockBeginWrite.mockResolvedValue({ journalId: 'jrn-new', applied, failed, indeterminate });
    mockSettleReverted.mockResolvedValue(true);
    mockResolveWriter.mockResolvedValue({
        kind: 'live',
        writer: { provider: 'active-directory', restore },
        close,
    });
    restore.mockResolvedValue(undefined);
});

describe('the happy path', () => {
    it('captures BEFORE writing, and reverts the original only AFTER', async () => {
        // The ordering is the claim. A capture taken afterwards cannot describe
        // what was replaced, and an original marked REVERTED before the write
        // lands would say a disable was undone by a restore that then failed.
        const r = await restoreAccount(ctx, 'acc-1');

        expect(r).toStrictEqual({
            kind: 'RESTORED', accountId: 'acc-1', journalId: 'jrn-new', revertedJournalId: 'jrn-old',
        });
        expect(mockBeginWrite.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
        expect(restore.mock.invocationCallOrder[0]).toBeLessThan(mockSettleReverted.mock.invocationCallOrder[0]);
    });

    it('hands the writer the CAPTURED state, which is what it compares against', async () => {
        await restoreAccount(ctx, 'acc-1');

        expect(restore).toHaveBeenCalledWith('guid-9', {
            enabled: true,
            priorState: { userAccountControl: 512 },
        });
    });

    it('journals the restore as its own write, naming the row it undoes', async () => {
        // Reverting the old row alone would record that something was undone
        // without recording who undid it, or when.
        await restoreAccount(ctx, 'acc-1');

        expect(mockBeginWrite.mock.calls[0][1]).toMatchObject({
            provider: 'active-directory',
            action: 'ENABLE_ACCOUNT',
            priorState: { restoredFromJournalId: 'jrn-old' },
        });
    });

    it('closes the writer', async () => {
        await restoreAccount(ctx, 'acc-1');
        expect(close).toHaveBeenCalled();
    });
});

describe('when there is nothing to restore', () => {
    it('answers NO_ACCOUNT without resolving a writer', async () => {
        mockLookup.mockResolvedValue({ kind: 'no-account' });

        expect(await restoreAccount(ctx, 'nope')).toStrictEqual({ kind: 'NO_ACCOUNT' });
        expect(mockResolveWriter).not.toHaveBeenCalled();
    });

    it('answers NO_CAPTURE for an account this product never disabled', async () => {
        // The existence of a capture is what authorises the restore — you
        // cannot put back a state nobody recorded.
        mockLookup.mockResolvedValue({ kind: 'no-capture', accountId: 'acc-1', provider: 'entra-id' });

        expect(await restoreAccount(ctx, 'acc-1')).toStrictEqual({ kind: 'NO_CAPTURE', accountId: 'acc-1' });
        expect(mockResolveWriter).not.toHaveBeenCalled();
    });
});

describe('when the directory cannot be written', () => {
    it('REFUSES on a writer that did not resolve live', async () => {
        mockResolveWriter.mockResolvedValue({ kind: 'none', refusal: 'SECRETS_UNREADABLE', detail: 'no creds' });

        expect(await restoreAccount(ctx, 'acc-1')).toStrictEqual({
            kind: 'REFUSED', accountId: 'acc-1', detail: 'no creds',
        });
    });

    it('REFUSES a snapshot writer rather than reporting its dry-run refusal', async () => {
        // The snapshot writer refuses every write by design; letting it answer
        // would describe this product's plumbing instead of the customer's
        // directory.
        mockResolveWriter.mockResolvedValue({ kind: 'snapshot', writer: {}, close });

        const r = await restoreAccount(ctx, 'acc-1');

        expect(r.kind).toBe('REFUSED');
        expect(restore).not.toHaveBeenCalled();
    });

    it('answers UNSUPPORTED — and closes — when the provider has no restore verb', async () => {
        // Its own outcome: a statement about what this product can do for that
        // directory, not about this connection. An operator reading it should
        // stop hunting for a misconfiguration.
        mockResolveWriter.mockResolvedValue({ kind: 'live', writer: { provider: 'okta' }, close });

        const r = await restoreAccount(ctx, 'acc-1');

        expect(r.kind).toBe('UNSUPPORTED');
        expect(close).toHaveBeenCalled();
    });
});

describe('when the write does not land', () => {
    it('settles FAILED and leaves the original row alone when the directory positively refused', async () => {
        // `definitivelyNotApplied` is the writer's own claim that nothing
        // changed. The original disable still stands, so it must stay
        // restorable.
        restore.mockRejectedValue(Object.assign(new Error('uac is 514, not 512'), { definitivelyNotApplied: true }));

        const r = await restoreAccount(ctx, 'acc-1');

        expect(r.kind).toBe('FAILED');
        expect(failed).toHaveBeenCalled();
        expect(mockSettleReverted).not.toHaveBeenCalled();
    });

    it('settles INDETERMINATE when the call did not report back', async () => {
        // Saying FAILED here would assert the directory is unchanged, which
        // nobody verified. The row stays unsettled so a human looks.
        restore.mockRejectedValue(new Error('socket hung up'));

        const r = await restoreAccount(ctx, 'acc-1');

        expect(r.kind).toBe('INDETERMINATE');
        expect(indeterminate).toHaveBeenCalled();
        expect(mockSettleReverted).not.toHaveBeenCalled();
    });

    it('closes the writer even when the write throws', async () => {
        restore.mockRejectedValue(new Error('boom'));
        await restoreAccount(ctx, 'acc-1');
        expect(close).toHaveBeenCalled();
    });
});
