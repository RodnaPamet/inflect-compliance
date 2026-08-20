/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and
 * spy harnesses that mirror runtime contracts; the file-level disable is
 * the codebase's standard pattern for these surfaces (see the sibling
 * tests/unit/usecases/audit-hardening.test.ts). */
/**
 * Regression — cross-tenant file oracle + freeze integrity
 * (branch harden/audits-backend).
 *
 * TASK 1 (CRITICAL). `verifyFileIntegrity` used to pass the caller-supplied
 * `fileName` straight to `getStorageProvider().readStream(fileName)` behind
 * ONLY a role check (`assertCanViewPack`, which passes for every role of every
 * tenant). Any member of any tenant could therefore hand another tenant's
 * storage key (URL-encoded slashes) and learn its existence + fileSize + sha256
 * — and confirm a guessed digest via `expectedHash`. The fix resolves the name
 * through a tenant-scoped `FileRecord` lookup and reads only the RESOLVED,
 * tenant-owned `pathKey` (with a defence-in-depth `tenants/<tenantId>/` prefix
 * assertion).
 *
 * TASK 2. `storeExportArtifact` used to require the pack be NON-DRAFT before
 * writing an arbitrary FILE item into it — i.e. it let content be injected into
 * an already-frozen, already-shared audit snapshot. The fix inverts the guard:
 * only a DRAFT pack accepts export writes; a frozen pack is immutable.
 */
import crypto from 'crypto';

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: jest.fn(),
    buildTenantObjectKey: jest.fn(),
    assertTenantKey: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    verifyFileIntegrity,
    storeExportArtifact,
} from '@/app-layer/usecases/audit-hardening';
import { runInTenantContext } from '@/lib/db-context';
import {
    getStorageProvider,
    buildTenantObjectKey,
    assertTenantKey,
} from '@/lib/storage';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetStorage = getStorageProvider as jest.MockedFunction<typeof getStorageProvider>;
const mockBuildKey = buildTenantObjectKey as jest.MockedFunction<typeof buildTenantObjectKey>;
const mockAssertTenantKey = assertTenantKey as jest.MockedFunction<typeof assertTenantKey>;

// Module-level storage spy so every test can assert on the SAME readStream fn.
const readStream = jest.fn();

/** Fresh single-shot async byte stream (the source does `for await …`). */
function bytesStream(content: string) {
    return (async function* () {
        yield Buffer.from(content, 'utf-8');
    })();
}

function sha256Hex(content: string): string {
    return crypto.createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

beforeEach(() => {
    // resetAllMocks() drains queued mockImplementationOnce entries (leakage
    // across tests triggers confusing failures) but also wipes the factory
    // implementations — re-prime them here, mirroring the sibling test file.
    jest.resetAllMocks();
    mockGetStorage.mockReturnValue({
        readStream,
        write: jest.fn().mockResolvedValue(undefined),
    } as never);
    mockBuildKey.mockImplementation(
        (tenantId: string, prefix: string, filename: string) =>
            `tenants/${tenantId}/${prefix}/${filename}`,
    );
    // Real prefix guard, so the defence-in-depth assertion is genuinely exercised.
    mockAssertTenantKey.mockImplementation((pathKey: string, tenantId: string) => {
        if (!pathKey.startsWith(`tenants/${tenantId}/`)) {
            throw new Error(
                `Tenant isolation violation: key "${pathKey}" does not belong to tenant "${tenantId}"`,
            );
        }
    });
});

describe('verifyFileIntegrity — cross-tenant file oracle (TASK 1)', () => {
    it('rejects a foreign/guessed storage key: no tenant-scoped FileRecord → notFound, storage NEVER read', async () => {
        // A low-privilege member of their own tenant (READER passes
        // assertCanViewPack) probes another tenant's storage key.
        mockRunInTx.mockImplementationOnce(async () => null as never);

        await expect(
            verifyFileIntegrity(
                makeRequestContext('READER'),
                'tenants/tenant-B/evidence/2026/07/secret_report.pdf', // foreign key
                'deadbeef'.repeat(8), // guessed digest — must NOT be confirmable
            ),
        ).rejects.toThrow(/File not found/);

        // The oracle is closed: no existence / size / hash is computed because
        // storage was never touched for an unresolved (foreign) key.
        expect(readStream).not.toHaveBeenCalled();
        // And the resolution was tenant-scoped (single lookup, filtered by tenantId).
        expect(mockRunInTx).toHaveBeenCalledTimes(1);
    });

    it('resolves an own-tenant file by pathKey and returns the true sha256 + size', async () => {
        const content = 'audit-report-bytes';
        const ownKey =
            'tenants/tenant-1/evidence/2026/07/aaaaaaaa-0000-4000-8000-000000000000_report.pdf';
        mockRunInTx.mockImplementationOnce(async () => ({ pathKey: ownKey } as never));
        readStream.mockImplementation(() => bytesStream(content));

        const expectedHash = sha256Hex(content);
        const result = await verifyFileIntegrity(
            makeRequestContext('ADMIN'),
            ownKey,
            expectedHash,
        );

        expect(readStream).toHaveBeenCalledWith(ownKey);
        expect(result.computedHash).toBe(expectedHash);
        expect(result.matches).toBe(true);
        expect(result.fileSize).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('resolves an own-tenant file by FileRecord id and reads the RESOLVED pathKey, never the raw id', async () => {
        const content = 'x';
        const ownKey =
            'tenants/tenant-1/evidence/2026/07/bbbbbbbb-0000-4000-8000-000000000000_f.bin';
        mockRunInTx.mockImplementationOnce(async () => ({ pathKey: ownKey } as never));
        readStream.mockImplementation(() => bytesStream(content));

        const result = await verifyFileIntegrity(makeRequestContext('ADMIN'), 'file-cuid-123');

        // Critical: storage is read from the resolved pathKey, NOT the caller id.
        expect(readStream).toHaveBeenCalledWith(ownKey);
        expect(readStream).not.toHaveBeenCalledWith('file-cuid-123');
        expect(result.matches).toBeNull(); // no expectedHash supplied
    });

    it('defence-in-depth: a resolved row whose pathKey escapes the tenant prefix is rejected before any read', async () => {
        // Simulate a corrupt/legacy FileRecord that slipped the tenantId filter
        // but whose pathKey points outside tenants/<tenantId>/.
        mockRunInTx.mockImplementationOnce(async () =>
            ({ pathKey: 'tenants/tenant-OTHER/evidence/2026/07/leak.pdf' } as never),
        );

        await expect(
            verifyFileIntegrity(makeRequestContext('ADMIN'), 'some-id'),
        ).rejects.toThrow(/isolation/i);

        expect(readStream).not.toHaveBeenCalled();
    });
});

describe('storeExportArtifact — freeze integrity (TASK 2)', () => {
    it('rejects writing an export into a non-DRAFT (frozen) pack — packs are immutable once frozen', async () => {
        mockRunInTx.mockImplementationOnce(async () =>
            ({ id: 'p1', status: 'FROZEN' } as never),
        );

        await expect(
            storeExportArtifact(
                makeRequestContext('ADMIN'),
                'p1',
                'content',
                'export.csv',
                'text/csv',
            ),
        ).rejects.toThrow(/immutable once frozen|non-DRAFT/);
    });

    it('allows writing an export into a DRAFT pack (attach-then-freeze)', async () => {
        mockRunInTx
            // pack lookup
            .mockImplementationOnce(async () => ({ id: 'p1', status: 'DRAFT' } as never))
            // auditPackItem.create
            .mockImplementationOnce(async (_ctx: any, fn: any) =>
                fn({ // storeExportArtifact re-verifies the pack is still DRAFT, holding
                    // its row, before creating the item.
                    auditPack: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                    auditPackItem: { create: jest.fn().mockResolvedValue({}) } }),
            )
            // logEvent wrapper
            .mockImplementationOnce(async (_ctx: any, fn: any) => fn({}));

        const result = await storeExportArtifact(
            makeRequestContext('ADMIN'),
            'p1',
            'content',
            'export.csv',
            'text/csv',
        );

        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
