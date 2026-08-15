/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Roadmap-26 PR-A — ProcessMap usecase tests.
 *
 * Pure-memory tests of create / list / get / save / delete:
 * Prisma and the audit emitter are mocked. The repo is mocked at
 * the boundary so each usecase's contract can be asserted without
 * needing a real DB.
 */

// VR-3 — save/get now probe canvasMode to gate the canvas↔rule sync.
// Default to a DOCUMENT map so the existing assertions (non-automation path)
// are unaffected.
const mockDb = {
    processMap: { findFirst: jest.fn().mockResolvedValue({ canvasMode: 'DOCUMENT' }) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: any, fn: (db: any) => any) => fn(mockDb),
    ),
}));

jest.mock('@/app-layer/repositories/ProcessMapRepository', () => ({
    ProcessMapRepository: {
        list: jest.fn(),
        getByIdWithGraph: jest.fn(),
        create: jest.fn(),
        replaceGraph: jest.fn(),
        softDelete: jest.fn(),
        setCanvasMode: jest.fn(),
        setStatus: jest.fn(),
        listMapsByLinkedEntity: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { logEvent } from '@/app-layer/events/audit';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import {
    listProcessMaps,
    getProcessMap,
    createProcessMap,
    saveProcessMap,
    setProcessMapCanvasMode,
    setProcessMapStatus,
    deleteProcessMap,
    listMapsUsingRisk,
    listMapsUsingAsset,
} from '@/app-layer/usecases/process-map';

function makeCtx(role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER'): RequestContext {
    return {
        requestId: `req-${role}`,
        userId: `user-${role.toLowerCase()}`,
        tenantId: 'tenant-1',
        role: role as any,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const writerCtx = makeCtx('ADMIN');
const readerCtx = makeCtx('READER');

const SAMPLE_MAP = {
    id: 'pm-1',
    name: 'Order-to-cash',
    description: null,
    status: 'DRAFT' as const,
    version: 1,
    createdAt: new Date('2026-05-19T10:00:00Z'),
    updatedAt: new Date('2026-05-19T10:00:00Z'),
    nodes: [],
    edges: [],
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('listProcessMaps', () => {
    it('returns the repo output untouched', async () => {
        (ProcessMapRepository.list as jest.Mock).mockResolvedValue([
            { ...SAMPLE_MAP, nodeCount: 0, edgeCount: 0 },
        ]);

        const result = await listProcessMaps(writerCtx);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('pm-1');
        expect(ProcessMapRepository.list).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
        );
    });

    it('allows readers to list', async () => {
        (ProcessMapRepository.list as jest.Mock).mockResolvedValue([]);
        await expect(listProcessMaps(readerCtx)).resolves.toEqual([]);
    });
});

describe('getProcessMap', () => {
    it('returns the loaded map', async () => {
        (ProcessMapRepository.getByIdWithGraph as jest.Mock).mockResolvedValue(
            SAMPLE_MAP,
        );

        const result = await getProcessMap(writerCtx, 'pm-1');

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.getByIdWithGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
        );
    });

    it('throws notFound when the repo returns null', async () => {
        (ProcessMapRepository.getByIdWithGraph as jest.Mock).mockResolvedValue(
            null,
        );
        await expect(getProcessMap(writerCtx, 'missing')).rejects.toThrow(
            'Process map not found',
        );
    });
});

describe('createProcessMap', () => {
    it('creates the map and emits a lifecycle audit event', async () => {
        (ProcessMapRepository.create as jest.Mock).mockResolvedValue(SAMPLE_MAP);

        const result = await createProcessMap(writerCtx, {
            name: 'Order-to-cash',
        });

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.create).toHaveBeenCalledWith(mockDb, writerCtx, {
            name: 'Order-to-cash',
            description: null,
            status: undefined,
            createdByUserId: writerCtx.userId,
        });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'ProcessMap',
                entityId: 'pm-1',
                detailsJson: expect.objectContaining({
                    operation: 'created',
                }),
            }),
        );
    });

    it('rejects readers', async () => {
        await expect(
            createProcessMap(readerCtx, { name: 'X' }),
        ).rejects.toThrow(/permission/i);
        expect(ProcessMapRepository.create).not.toHaveBeenCalled();
    });
});

describe('saveProcessMap', () => {
    it('replaces the graph and bumps version via the repo', async () => {
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue({
            ...SAMPLE_MAP,
            version: 2,
            nodes: [
                {
                    nodeKey: 'node-1',
                    nodeType: 'processStep',
                    label: 'Receive order',
                    subtitle: null,
                    posX: 0,
                    posY: 0,
                    dataJson: null,
                },
            ],
            edges: [],
        });

        const result = await saveProcessMap(writerCtx, 'pm-1', {
            nodes: [
                {
                    nodeKey: 'node-1',
                    nodeType: 'processStep',
                    label: 'Receive order',
                    posX: 0,
                    posY: 0,
                },
            ],
            edges: [],
        });

        expect(result.version).toBe(2);
        expect(result.nodes).toHaveLength(1);
        expect(ProcessMapRepository.replaceGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            expect.objectContaining({
                nodes: expect.arrayContaining([
                    expect.objectContaining({ nodeKey: 'node-1' }),
                ]),
                edges: [],
            }),
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({
                action: 'UPDATE',
                entityType: 'ProcessMap',
                entityId: 'pm-1',
                detailsJson: expect.objectContaining({
                    operation: 'updated',
                    after: expect.objectContaining({ version: 2 }),
                }),
            }),
        );
    });

    it('throws notFound when the map does not exist', async () => {
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue(null);
        await expect(
            saveProcessMap(writerCtx, 'pm-missing', { nodes: [], edges: [] }),
        ).rejects.toThrow('Process map not found');
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('rejects readers', async () => {
        await expect(
            saveProcessMap(readerCtx, 'pm-1', { nodes: [], edges: [] }),
        ).rejects.toThrow(/permission/i);
    });

    it('forwards expectedVersion to the repo (Epic P1)', async () => {
        // The usecase is a thin orchestration layer — `expectedVersion`
        // arrives from the route's Zod-validated body and must flow to
        // the repo verbatim. Anchoring this here means a future
        // refactor that silently drops the field gets caught before
        // anyone notices the concurrency check stopped firing.
        (ProcessMapRepository.replaceGraph as jest.Mock).mockResolvedValue({
            ...SAMPLE_MAP,
            version: 3,
            nodes: [],
            edges: [],
        });

        await saveProcessMap(writerCtx, 'pm-1', {
            nodes: [],
            edges: [],
            expectedVersion: 2,
        });

        expect(ProcessMapRepository.replaceGraph).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            expect.objectContaining({ expectedVersion: 2 }),
        );
    });
});

describe('deleteProcessMap', () => {
    it('soft-deletes and emits an audit event', async () => {
        (ProcessMapRepository.softDelete as jest.Mock).mockResolvedValue(true);

        const result = await deleteProcessMap(writerCtx, 'pm-1');

        expect(result.id).toBe('pm-1');
        expect(ProcessMapRepository.softDelete).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            'pm-1',
            writerCtx.userId,
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            writerCtx,
            expect.objectContaining({ action: 'DELETE', entityType: 'ProcessMap' }),
        );
    });

    it('throws notFound when the row was already gone', async () => {
        (ProcessMapRepository.softDelete as jest.Mock).mockResolvedValue(false);
        await expect(deleteProcessMap(writerCtx, 'pm-missing')).rejects.toThrow(
            'Process map not found',
        );
    });

    /**
     * An EDITOR could delete any process map in the tenant, and unlike every
     * other register that is UNRECOVERABLE: ProcessMap is in neither
     * SOFT_DELETE_MODELS nor the SoftDeletableModel union, so no role — not
     * ADMIN, not OWNER — has a restore surface. It also silently drops
     * control-coverage placements out of the "where is this control used?"
     * panel, because both reverse-lookup queries filter deleted maps.
     *
     * The existing tests above pass either way: `writerCtx` is already ADMIN.
     * That is exactly why the gap survived — nothing exercised the tier it
     * actually let through.
     */
    it('refuses an EDITOR — the delete is irreversible, so the gate is the only guard', async () => {
        (ProcessMapRepository.softDelete as jest.Mock).mockClear();

        await expect(deleteProcessMap(makeCtx('EDITOR'), 'pm-1')).rejects.toThrow();
        // Refused BEFORE any write, so a denial cannot be mistaken for a
        // successful delete of a missing row.
        expect(ProcessMapRepository.softDelete).not.toHaveBeenCalled();
    });

    it('refuses a READER too', async () => {
        await expect(deleteProcessMap(makeCtx('READER'), 'pm-1')).rejects.toThrow();
    });
});

describe('setProcessMapCanvasMode', () => {
    it('switches mode + audits when the map exists', async () => {
        (ProcessMapRepository.setCanvasMode as jest.Mock).mockResolvedValue(true);
        const res = await setProcessMapCanvasMode(writerCtx, 'pm-1', 'AUTOMATION');
        expect(res).toEqual({ id: 'pm-1', canvasMode: 'AUTOMATION' });
        expect(ProcessMapRepository.setCanvasMode).toHaveBeenCalledWith(
            mockDb, writerCtx, 'pm-1', 'AUTOMATION',
        );
        expect(logEvent).toHaveBeenCalled();
    });

    it('throws notFound when no map matched', async () => {
        (ProcessMapRepository.setCanvasMode as jest.Mock).mockResolvedValue(false);
        await expect(
            setProcessMapCanvasMode(writerCtx, 'pm-missing', 'DOCUMENT'),
        ).rejects.toThrow('Process map not found');
    });

    it('rejects a reader (no write permission)', async () => {
        await expect(
            setProcessMapCanvasMode(makeCtx('READER'), 'pm-1', 'AUTOMATION'),
        ).rejects.toBeDefined();
    });
});

describe('setProcessMapStatus (PR-F)', () => {
    it('sets the lifecycle status + audits when the map exists', async () => {
        (ProcessMapRepository.setStatus as jest.Mock).mockResolvedValue(true);
        const res = await setProcessMapStatus(writerCtx, 'pm-1', 'ARCHIVED');
        expect(res).toEqual({ id: 'pm-1', status: 'ARCHIVED' });
        expect(ProcessMapRepository.setStatus).toHaveBeenCalledWith(
            mockDb, writerCtx, 'pm-1', 'ARCHIVED',
        );
        expect(logEvent).toHaveBeenCalled();
    });

    it('throws notFound when no map matched', async () => {
        (ProcessMapRepository.setStatus as jest.Mock).mockResolvedValue(false);
        await expect(
            setProcessMapStatus(writerCtx, 'pm-missing', 'ACTIVE'),
        ).rejects.toThrow('Process map not found');
    });

    it('rejects a reader (no write permission)', async () => {
        await expect(
            setProcessMapStatus(makeCtx('READER'), 'pm-1', 'ACTIVE'),
        ).rejects.toBeDefined();
    });
});

describe('node-link reverse lookups (PR-D)', () => {
    const ROW = [
        {
            mapId: 'pm-1',
            mapName: 'Onboarding',
            mapStatus: 'ACTIVE',
            nodeKey: 'node-3',
            nodeLabel: 'DB',
        },
    ];

    it('listMapsUsingRisk queries the repo with the risk node kind', async () => {
        (ProcessMapRepository.listMapsByLinkedEntity as jest.Mock).mockResolvedValue(
            ROW,
        );
        const result = await listMapsUsingRisk(readerCtx, 'risk-9');
        expect(result).toEqual(ROW);
        expect(ProcessMapRepository.listMapsByLinkedEntity).toHaveBeenCalledWith(
            mockDb,
            readerCtx,
            'risk',
            'risk-9',
        );
    });

    it('listMapsUsingAsset queries the repo with the asset node kind', async () => {
        (ProcessMapRepository.listMapsByLinkedEntity as jest.Mock).mockResolvedValue(
            ROW,
        );
        const result = await listMapsUsingAsset(readerCtx, 'asset-2');
        expect(result).toEqual(ROW);
        expect(ProcessMapRepository.listMapsByLinkedEntity).toHaveBeenCalledWith(
            mockDb,
            readerCtx,
            'asset',
            'asset-2',
        );
    });

    it('both are read-only — a reader is allowed', async () => {
        (ProcessMapRepository.listMapsByLinkedEntity as jest.Mock).mockResolvedValue(
            [],
        );
        await expect(listMapsUsingRisk(readerCtx, 'r')).resolves.toEqual([]);
        await expect(listMapsUsingAsset(readerCtx, 'a')).resolves.toEqual([]);
    });
});
