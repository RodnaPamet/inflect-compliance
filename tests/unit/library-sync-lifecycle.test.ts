/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Library Sync Usecase Tests
 *
 * Validates the library reload lifecycle orchestration:
 * 1. Framework libraries import (phase 1) runs before mapping sets (phase 2)
 * 2. Repeated sync is idempotent
 * 3. Mapping import failures are isolated — they don't block framework sync
 * 4. skipMappings option disables phase 2
 * 5. SyncResult contains structured mapping set results
 *
 * These tests use mocking to isolate the sync orchestration logic
 * from actual I/O and database operations.
 */

import type { ImportResult } from '@/app-layer/services/library-importer';
import type { ImportMappingSetResult } from '@/app-layer/services/mapping-set-importer';

// ─── Track call order across modules ─────────────────────────────────

const callOrder: string[] = [];

// ─── Mock library-importer ───────────────────────────────────────────

const mockImportAllFromDirectory = jest.fn<Promise<ImportResult[]>, any[]>();

jest.mock('@/app-layer/services/library-importer', () => ({
    importAllFromDirectory: (...args: any[]) => {
        callOrder.push('importAllFromDirectory');
        return mockImportAllFromDirectory(...args);
    },
}));

// ─── Mock mapping-set-importer ───────────────────────────────────────

const mockImportAllMappingSets = jest.fn<Promise<ImportMappingSetResult[]>, any[]>();

jest.mock('@/app-layer/services/mapping-set-importer', () => ({
    importAllMappingSets: (...args: any[]) => {
        callOrder.push('importAllMappingSets');
        return mockImportAllMappingSets(...args);
    },
}));

// ─── Mock libraries module ──────────────────────────────────────────

jest.mock('@/app-layer/libraries', () => ({
    scanLibraryDirectory: jest.fn().mockReturnValue([]),
    parseLibraryFile: jest.fn(),
    loadLibrary: jest.fn(),
    loadAllFromDirectory: jest.fn().mockReturnValue(new Map()),
}));

// ─── Mock observability (passthrough) ────────────────────────────────

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<any>) => fn()),
}));

jest.mock('@/lib/observability/context', () => ({
    runWithRequestContext: jest.fn(async (_ctx: any, fn: () => Promise<any>) => fn()),
}));

jest.mock('@/lib/observability/tracing', () => ({
    traceOperation: jest.fn(async (_name: string, _attrs: any, fn: () => Promise<any>) => fn()),
}));

jest.mock('@/lib/observability/sentry', () => ({
    captureError: jest.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────────────

import { syncAllLibraries } from '@/app-layer/usecases/library-sync';
import { logger } from '@/lib/observability/logger';

// ─── Fixtures ────────────────────────────────────────────────────────

function makeFrameworkResult(action: 'created' | 'updated' | 'skipped', urn: string): ImportResult {
    return {
        action,
        frameworkKey: urn.split(':').pop()!,
        frameworkName: urn,
        urn,
        requirementStats: { created: 10, updated: 0, deprecated: 0, unchanged: 0, total: 10 },
        durationMs: 50,
    } as unknown as ImportResult;
}

function makeMappingResult(overrides: Partial<ImportMappingSetResult> = {}): ImportMappingSetResult {
    return {
        mappingSetId: 'ms-1',
        name: 'ISO → NIST',
        sourceFrameworkRef: 'ISO27001-2022',
        targetFrameworkRef: 'NIST-CSF-2.0',
        created: 14,
        updated: 0,
        skippedDuplicate: false,
        errors: [],
        ...overrides,
    };
}

const mockDb = {} as any;

// ─── Tests ───────────────────────────────────────────────────────────

describe('Library Sync Usecase', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        callOrder.length = 0;

        // Default: frameworks sync ok, mappings sync ok
        mockImportAllFromDirectory.mockResolvedValue([
            makeFrameworkResult('created', 'urn:inflect:framework:ISO27001-2022'),
            makeFrameworkResult('skipped', 'urn:inflect:framework:NIST-CSF-2.0'),
        ]);
        mockImportAllMappingSets.mockResolvedValue([
            makeMappingResult(),
        ]);
    });

    // ─── Phase ordering ──────────────────────────────────────────
    describe('lifecycle ordering', () => {
        it('imports frameworks BEFORE mapping sets', async () => {
            await syncAllLibraries(mockDb);

            expect(callOrder).toEqual([
                'importAllFromDirectory',
                'importAllMappingSets',
            ]);
        });

        it('passes db to both phases', async () => {
            await syncAllLibraries(mockDb);

            expect(mockImportAllFromDirectory).toHaveBeenCalledWith(
                mockDb,
                expect.any(String), // LIBRARIES_DIR
                undefined,          // no options passed
                undefined,          // no framework keys skipped
            );
            expect(mockImportAllMappingSets).toHaveBeenCalledWith(
                mockDb,
                undefined,
                expect.objectContaining({}),
            );
        });

        it('does not call mapping import if framework import throws', async () => {
            mockImportAllFromDirectory.mockRejectedValue(new Error('DB down'));

            await expect(syncAllLibraries(mockDb)).rejects.toThrow('DB down');
            expect(mockImportAllMappingSets).not.toHaveBeenCalled();
        });
    });

    // ─── SyncResult structure ────────────────────────────────────
    describe('SyncResult', () => {
        it('includes framework results with correct summary', async () => {
            const result = await syncAllLibraries(mockDb);

            expect(result.totalFound).toBe(2);
            expect(result.summary.created).toBe(1);
            expect(result.summary.skipped).toBe(1);
            expect(result.summary.updated).toBe(0);
            expect(result.summary.failed).toBe(0);
        });

        it('includes mapping set results with correct summary', async () => {
            const result = await syncAllLibraries(mockDb);

            expect(result.mappingSets.results).toHaveLength(1);
            expect(result.mappingSets.summary.imported).toBe(1);
            expect(result.mappingSets.summary.skipped).toBe(0);
            expect(result.mappingSets.summary.totalEntries).toBe(14);
        });

        it('reports skipped mapping sets correctly', async () => {
            mockImportAllMappingSets.mockResolvedValue([
                makeMappingResult({ skippedDuplicate: true, created: 0, updated: 0 }),
                makeMappingResult({ skippedDuplicate: false, created: 5, updated: 3 }),
            ]);

            const result = await syncAllLibraries(mockDb);

            expect(result.mappingSets.summary.imported).toBe(1);
            expect(result.mappingSets.summary.skipped).toBe(1);
            expect(result.mappingSets.summary.totalEntries).toBe(8); // 5+3
        });

        it('reports mapping entry-level errors without blocking', async () => {
            mockImportAllMappingSets.mockResolvedValue([
                makeMappingResult({
                    created: 10,
                    errors: [
                        { entry: 5, sourceRef: 'A.5.99', targetRef: 'GV.XX-99', message: 'not found' },
                        { entry: 8, sourceRef: 'A.5.98', targetRef: 'GV.XX-98', message: 'not found' },
                    ],
                }),
            ]);

            const result = await syncAllLibraries(mockDb);

            expect(result.mappingSets.summary.imported).toBe(1);
            expect(result.mappingSets.summary.failed).toBe(2);
            expect(result.mappingSets.summary.totalEntries).toBe(10);
        });

        it('includes totalDurationMs', async () => {
            const result = await syncAllLibraries(mockDb);
            expect(typeof result.totalDurationMs).toBe('number');
        });
    });

    // ─── Idempotency ─────────────────────────────────────────────
    describe('idempotency', () => {
        it('repeated sync with same data produces same structure', async () => {
            const r1 = await syncAllLibraries(mockDb);
            const r2 = await syncAllLibraries(mockDb);

            expect(r1.totalFound).toBe(r2.totalFound);
            expect(r1.summary).toEqual(r2.summary);
            expect(r1.mappingSets.summary).toEqual(r2.mappingSets.summary);
        });

        it('repeated sync calls both phases each time', async () => {
            await syncAllLibraries(mockDb);
            await syncAllLibraries(mockDb);

            expect(mockImportAllFromDirectory).toHaveBeenCalledTimes(2);
            expect(mockImportAllMappingSets).toHaveBeenCalledTimes(2);
        });
    });

    // ─── Mapping failure isolation ───────────────────────────────
    describe('mapping failure isolation', () => {
        it('mapping import failure does not throw from syncAllLibraries', async () => {
            mockImportAllMappingSets.mockRejectedValue(new Error('Mapping DB error'));

            const result = await syncAllLibraries(mockDb);

            // Framework results are preserved
            expect(result.totalFound).toBe(2);
            expect(result.summary.created).toBe(1);
            // Mapping results are empty (failure was caught)
            expect(result.mappingSets.results).toHaveLength(0);
        });

        it('mapping import failure is logged as error', async () => {
            mockImportAllMappingSets.mockRejectedValue(new Error('Connection reset'));

            await syncAllLibraries(mockDb);

            expect(logger.error).toHaveBeenCalledWith(
                'Phase 2 failed — mapping set import error',
                expect.objectContaining({
                    component: 'library-sync',
                    error: 'Connection reset',
                }),
            );
        });

        it('framework import failure IS propagated (not isolated)', async () => {
            mockImportAllFromDirectory.mockRejectedValue(new Error('Schema mismatch'));

            await expect(syncAllLibraries(mockDb)).rejects.toThrow('Schema mismatch');
        });
    });

    // ─── skipMappings option ─────────────────────────────────────
    describe('skipMappings option', () => {
        it('skips mapping import when skipMappings=true', async () => {
            const result = await syncAllLibraries(mockDb, { skipMappings: true });

            expect(mockImportAllMappingSets).not.toHaveBeenCalled();
            expect(result.mappingSets.results).toHaveLength(0);
            expect(result.mappingSets.summary.imported).toBe(0);
        });

        it('still imports frameworks when skipMappings=true', async () => {
            const result = await syncAllLibraries(mockDb, { skipMappings: true });

            expect(mockImportAllFromDirectory).toHaveBeenCalled();
            expect(result.totalFound).toBe(2);
        });

        it('logs skip message when skipMappings=true', async () => {
            await syncAllLibraries(mockDb, { skipMappings: true });

            expect(logger.info).toHaveBeenCalledWith(
                'Phase 2 skipped — skipMappings=true',
                expect.objectContaining({ component: 'library-sync' }),
            );
        });
    });

    // ─── Force option propagation ────────────────────────────────
    describe('force option propagation', () => {
        it('propagates force option to framework import', async () => {
            await syncAllLibraries(mockDb, { force: true });

            expect(mockImportAllFromDirectory).toHaveBeenCalledWith(
                mockDb,
                expect.any(String),
                expect.objectContaining({ force: true }),
                undefined,
            );
        });

        it('propagates force option to mapping import', async () => {
            await syncAllLibraries(mockDb, { force: true });

            expect(mockImportAllMappingSets).toHaveBeenCalledWith(
                mockDb,
                undefined,
                expect.objectContaining({ force: true }),
            );
        });
    });
});
