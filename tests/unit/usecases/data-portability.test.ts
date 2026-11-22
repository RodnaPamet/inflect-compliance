/**
 * Unit tests for src/app-layer/usecases/data-portability.ts
 *
 * Closes a critical zero-coverage gap from GAP-02. The data-portability
 * usecase is the single most dangerous endpoint in the system from a
 * cross-tenant-leak standpoint:
 *   - Export reads tenant data from EVERY model and packages it.
 *   - Import writes into the current tenant from a foreign-origin bundle.
 *
 * The load-bearing security properties tested here:
 *   1. Export RBAC: requires canExport OR canAdmin; READER without
 *      export gets 403.
 *   2. Import RBAC: requires canAdmin (strictly stricter than export
 *      because import is destructive). EDITOR with canExport but
 *      without canAdmin must NOT be able to import.
 *   3. Import target tenant lock: even an admin in tenant A CANNOT
 *      import a bundle into tenant B by passing a different tenantId.
 *      The usecase always uses ctx.tenantId, never trusts the bundle.
 *   4. Audit emission for both export AND import (including dryRun).
 *   5. Buffer import inherits the same gates.
 */

jest.mock('@/app-layer/services/export-service', () => ({
    exportTenantData: jest.fn(),
}));

jest.mock('@/app-layer/services/import-service', () => ({
    importTenantData: jest.fn(),
    validateImportEnvelope: jest.fn(),
    deserializeBundle: jest.fn(),
}));

// Audit rows go through `logEvent` (hash chain + SIEM stream, #5262).
const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) => {
        const fakeDb = { auditLog: { create: jest.fn() } };
        return fn(fakeDb);
    }),
}));

import {
    exportBundle,
    validateBundle,
    importBundle,
    importFromBuffer,
} from '@/app-layer/usecases/data-portability';
import { exportTenantData } from '@/app-layer/services/export-service';
import { importTenantData, validateImportEnvelope } from '@/app-layer/services/import-service';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

const mockExport = exportTenantData as jest.MockedFunction<typeof exportTenantData>;
const mockImport = importTenantData as jest.MockedFunction<typeof importTenantData>;
const mockValidate = validateImportEnvelope as jest.MockedFunction<typeof validateImportEnvelope>;
const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sampleEnvelope: any = {
    formatVersion: '1.0',
    metadata: { tenantId: 'tenant-A', exportedAt: new Date().toISOString() },
    domains: {},
};

const successfulExport = {
    envelope: sampleEnvelope,
    stats: { entityCount: 42, relationshipCount: 7, durationMs: 12, domains: ['FULL_TENANT'] },
};

const successfulImport = {
    success: true,
    imported: { Risk: 5 },
    skipped: { Asset: 2 },
    conflicts: [],
    errors: [],
    durationMs: 33,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockExport.mockResolvedValue(successfulExport as never);
    mockImport.mockResolvedValue(successfulImport as never);
    mockValidate.mockResolvedValue({ ...successfulImport } as never);
});

describe('exportBundle — RBAC', () => {
    it('rejects READER without canExport with 403', async () => {
        const ctx = makeRequestContext('READER');
        // READER has canExport=false in makeRequestContext.
        await expect(
            exportBundle(ctx, {} as never),
        ).rejects.toThrow(/permission to export/);
        expect(mockExport).not.toHaveBeenCalled();
    });

    it('allows EDITOR (canExport=true) to export', async () => {
        const ctx = makeRequestContext('EDITOR');
        await expect(exportBundle(ctx, {} as never)).resolves.toBeTruthy();
        expect(mockExport).toHaveBeenCalled();
    });

    it('allows ADMIN (canAdmin=true) to export', async () => {
        const ctx = makeRequestContext('ADMIN');
        await expect(exportBundle(ctx, {} as never)).resolves.toBeTruthy();
    });

    it('passes ctx.tenantId — never trusts a bundle-supplied tenantId', async () => {
        const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-X' });
        await exportBundle(ctx, {} as never);
        const exportArgs = mockExport.mock.calls[0][0];
        // Regression: a bug that read tenantId from `request` would
        // export the wrong tenant's data.
        expect(exportArgs.tenantId).toBe('tenant-X');
        expect(exportArgs.exportedBy).toBe(ctx.userId);
    });

    it('emits a DATA_EXPORT audit row inside runInTenantContext', async () => {
        const ctx = makeRequestContext('ADMIN');
        await exportBundle(ctx, {} as never);
        expect(mockRunInTx).toHaveBeenCalled();
        const auditCb = mockRunInTx.mock.calls[0][1];
        mockLogEvent.mockClear();
        await auditCb({} as never);
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({
                action: 'DATA_EXPORT',
                entityType: 'DataPortability',
                detailsJson: expect.objectContaining({ category: 'data_lifecycle' }),
            }),
        );
    });
});

describe('importBundle — RBAC stricter than export', () => {
    const importReq = {
        envelope: sampleEnvelope,
        conflictStrategy: 'SKIP' as const,
        dryRun: false,
    };

    it('rejects EDITOR — import requires canAdmin even with canExport=true', async () => {
        const ctx = makeRequestContext('EDITOR');
        // EDITOR has canExport=true but canAdmin=false.
        // Regression: a buggy share of policy logic between export and
        // import would let any can-export role import too. The
        // separation is what protects tenants from a compromised
        // EDITOR account from overwriting state via import.
        await expect(
            importBundle(ctx, importReq as never),
        ).rejects.toThrow(/administrative actions/);
        expect(mockImport).not.toHaveBeenCalled();
    });

    it('rejects READER on import', async () => {
        const ctx = makeRequestContext('READER');
        await expect(
            importBundle(ctx, importReq as never),
        ).rejects.toThrow();
        expect(mockImport).not.toHaveBeenCalled();
    });

    it('allows ADMIN to import — happy path', async () => {
        const ctx = makeRequestContext('ADMIN');
        const result = await importBundle(ctx, importReq as never);
        expect(result).toEqual(successfulImport);
        expect(mockImport).toHaveBeenCalled();
    });

    it('forces target tenantId to ctx.tenantId — bundle metadata is informational only', async () => {
        const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-DEST' });
        // Bundle was exported FROM 'tenant-SRC', but import goes INTO
        // ctx.tenantId no matter what the bundle says.
        const req = {
            ...importReq,
            envelope: { ...sampleEnvelope, metadata: { tenantId: 'tenant-SRC' } },
        };
        await importBundle(ctx, req as never);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const importArgs = mockImport.mock.calls[0] as any[];
        expect(importArgs[1].targetTenantId).toBe('tenant-DEST');
        // Regression: passing through bundle.metadata.tenantId would
        // be a cross-tenant write — exactly the class of bug the
        // assertImportTargetMatchesContext check exists to prevent.
    });

    it('still emits an audit row when dryRun=true (audit captures intent + outcome)', async () => {
        const ctx = makeRequestContext('ADMIN');
        await importBundle(ctx, { ...importReq, dryRun: true } as never);
        const auditCb = mockRunInTx.mock.calls[0][1];
        mockLogEvent.mockClear();
        await auditCb({} as never);
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({
                action: 'DATA_IMPORT_DRYRUN',
                entityType: 'DataPortability',
                detailsJson: expect.objectContaining({ category: 'data_lifecycle' }),
            }),
        );
    });

    it('emits DATA_IMPORT (not dryrun) on a real import', async () => {
        const ctx = makeRequestContext('ADMIN');
        await importBundle(ctx, importReq as never);
        const auditCb = mockRunInTx.mock.calls[0][1];
        mockLogEvent.mockClear();
        await auditCb({} as never);
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({
                action: 'DATA_IMPORT',
                entityType: 'DataPortability',
                detailsJson: expect.objectContaining({ category: 'data_lifecycle' }),
            }),
        );
    });
});

describe('validateBundle — RBAC mirrors importBundle', () => {
    it('rejects EDITOR — validate exposes data shape, requires canAdmin', async () => {
        const ctx = makeRequestContext('EDITOR');
        await expect(
            validateBundle(ctx, sampleEnvelope as never),
        ).rejects.toThrow();
        expect(mockValidate).not.toHaveBeenCalled();
    });

    it('passes ctx.tenantId to validateImportEnvelope as the target', async () => {
        const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-DEST' });
        await validateBundle(ctx, sampleEnvelope as never);
        expect(mockValidate).toHaveBeenCalledWith(sampleEnvelope, 'tenant-DEST');
    });
});

describe('importFromBuffer — buffer entrypoint inherits all gates', () => {
    it('rejects EDITOR identically to importBundle (same canAdmin gate)', async () => {
        const ctx = makeRequestContext('EDITOR');
        await expect(
            importFromBuffer(ctx, Buffer.from('zz'), { conflictStrategy: 'SKIP' } as never),
        ).rejects.toThrow();
        // Regression: a buffer-mode bypass of the export/import RBAC
        // would be a privilege-escalation vector — assert the same
        // gate fires before any deserialize.
        expect(mockImport).not.toHaveBeenCalled();
    });
});
