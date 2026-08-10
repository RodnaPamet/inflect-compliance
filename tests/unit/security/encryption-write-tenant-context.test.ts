/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts; the file-level disable is this repo's standard for these
 * surfaces. */

/**
 * A write is encrypted with the AMBIENT tenant's key, never the row's.
 *
 * That asymmetry is the whole bug class. `create({ data: { tenantId: B, … } })`
 * executed while the context says A encrypts B's row under A's DEK, succeeds,
 * and corrupts silently. What surfaces — much later, on an unrelated read — is
 *
 *   DecryptIntegrityError: failed to decrypt Task.description (v2) with an
 *   available tenant DEK — wrong key, corrupt row, or a write made under a
 *   mismatched tenant context
 *
 * and that error can name the unreadable row but not the write that produced
 * it. E2E carries 6-9 of those 500s per run, on green runs as well as red, and
 * none of them is traceable to a writer.
 *
 * The write is the only moment where both the ambient tenant and the row's
 * tenant are still in scope, so it is the only place the question can be
 * answered. These tests pin the detector that asks it.
 *
 * Observation-only by design — see `checkWriteTenantContext`. The assertions
 * below are therefore about what is REPORTED, not about a throw.
 */

const auditCtx: { value: { tenantId?: string; source?: string } | undefined } = {
    value: undefined,
};

jest.mock('@/lib/audit-context', () => ({
    getAuditContext: () => auditCtx.value,
}));

const warn = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), error: (...a: unknown[]) => error(...a), info: jest.fn(), debug: jest.fn() },
}));

const recordMismatch = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({
    recordFieldDecryptFailure: jest.fn(),
    recordTenantContextMismatch: (...a: unknown[]) => recordMismatch(...a),
}));

import { _internals } from '@/lib/db/encryption-middleware';

const checkWriteTenantContext = _internals.checkWriteTenantContext as (
    data: unknown,
    model: string,
    operation: string,
) => void;

beforeEach(() => {
    warn.mockClear();
    error.mockClear();
    recordMismatch.mockClear();
    auditCtx.value = undefined;
});

describe('a write for another tenant is reported', () => {
    it('flags ambient A writing a row that says tenant B', () => {
        // The corruption. B's row is about to be sealed with A's key.
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext({ tenantId: 'tenant-B', description: 'x' }, 'Finding', 'create');

        expect(recordMismatch).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'Finding', operation: 'create', outcome: 'mismatch' }),
        );
    });

    it('logs BOTH tenant ids — the read-side error has neither', () => {
        // The read can say "this row will not decrypt". Only the write knows
        // who wrote it and under which context, so that is what gets logged.
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext({ tenantId: 'tenant-B', description: 'x' }, 'Task', 'update');

        const [event, fields] = error.mock.calls[0] as [string, Record<string, unknown>];
        expect(event).toBe('encryption-middleware.write_tenant_mismatch');
        expect(fields).toMatchObject({
            model: 'Task',
            operation: 'update',
            ambientTenantId: 'tenant-A',
            rowTenantId: 'tenant-B',
        });
    });

    it('says nothing when the ambient tenant and the row agree', () => {
        // The overwhelmingly common case. A detector that fires here would be
        // noise, and noise is how a real signal gets muted.
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext({ tenantId: 'tenant-A', description: 'x' }, 'Finding', 'create');

        expect(recordMismatch).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});

describe('a tenant-owned row written with no context is reported separately', () => {
    it('flags it as `unscoped`, not as a mismatch', () => {
        // Different failure, different fix: this one stays READABLE (global
        // KEK, `v1:`) but sits outside per-tenant key isolation, and a
        // tenant-DEK rotation will not re-key it. Collapsing the two outcomes
        // into one number is what hid the corruption inside routine noise
        // before.
        auditCtx.value = undefined;
        checkWriteTenantContext({ tenantId: 'tenant-B', description: 'x' }, 'Finding', 'create');

        expect(recordMismatch).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'unscoped', model: 'Finding' }),
        );
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
    });
});

describe('what the detector deliberately ignores', () => {
    it('ignores a filter object — `{ in: [...] }` is a predicate, not an identity', () => {
        // `updateMany({ where: { tenantId: { in: [...] } } })` shapes reach the
        // write args too. Comparing a string against a filter would report
        // every cross-tenant sweep as corruption.
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext({ tenantId: { in: ['tenant-B', 'tenant-C'] } }, 'IncidentNotification', 'updateMany');

        expect(recordMismatch).not.toHaveBeenCalled();
    });

    it('ignores a payload that encrypts nothing', () => {
        // Tenant bootstrap writes TenantMembership / TenantOnboarding rows
        // before any context exists — correct, and encrypting nothing. Before
        // this gate those produced a constant stream that buried the real
        // signal: a first run over the integration suite emitted one genuine
        // cross-tenant mismatch and dozens of these.
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext({ tenantId: 'tenant-B', role: 'OWNER' }, 'TenantMembership', 'create');
        expect(recordMismatch).not.toHaveBeenCalled();
    });

    it.each([
        ['no tenantId at all', { description: 'x' }],
        ['an empty tenantId', { tenantId: '' }],
        ['a null payload', null],
        ['an array payload', [{ tenantId: 'tenant-B' }]],
    ])('ignores %s', (_label, data) => {
        auditCtx.value = { tenantId: 'tenant-A' };
        checkWriteTenantContext(data, 'Finding', 'create');
        expect(recordMismatch).not.toHaveBeenCalled();
    });

    it('does not throw — this is observation, not enforcement', () => {
        // Several legitimate-looking cross-tenant writers exist today. Throwing
        // before they are understood trades a silent corruption for a loud
        // outage; the read path made the same call for `decrypt_failed`.
        auditCtx.value = { tenantId: 'tenant-A' };
        expect(() =>
            checkWriteTenantContext({ tenantId: 'tenant-B', description: 'x' }, 'Finding', 'create'),
        ).not.toThrow();
    });
});
