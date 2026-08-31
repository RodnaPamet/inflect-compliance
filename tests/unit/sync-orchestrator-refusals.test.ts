/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles and
 * deliberate contract violations (a store that answers null where the happy
 * path answers a row). Per-line typing has poor cost/benefit here; the
 * file-level disable is this repo's standard for test harness surfaces, and
 * matches tests/unit/sync-orchestrator.test.ts. */
/**
 * `BaseSyncOrchestrator` — what happens when nothing goes to plan.
 *
 * `tests/unit/sync-orchestrator.test.ts` drives the engine with a store that
 * behaves. That leaves the branches this file is about: the ones taken when the
 * store disagrees with itself between the try block and the catch block, when a
 * webhook names a record we have never mapped, and when a subclass reports a
 * conflict on a PUSH.
 *
 * Two of these need a store that is deliberately inconsistent, so they use a
 * hand-driven double rather than the in-memory store. That is the point: the
 * catch block re-reads the mapping from scratch precisely because the first
 * read may no longer be true, and a store that always agrees with itself can
 * never exercise it.
 */
import {
    BaseSyncOrchestrator,
    type SyncMappingStore,
    type SyncEventLogger,
} from '@/app-layer/integrations/sync-orchestrator';
import type { RequestContext } from '@/app-layer/types';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
    SyncEvent,
    ConflictDetails,
    ConflictCheckResult,
    SyncDirection,
} from '@/app-layer/integrations/sync-types';
import {
    BaseIntegrationClient,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '@/app-layer/integrations/base-client';
import { BaseFieldMapper, type FieldMappings } from '@/app-layer/integrations/base-mapper';
import { makeRequestContext } from '../helpers/make-context';

jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'mock-job' }),
}));
import { enqueue } from '@/app-layer/jobs/queue';

const ctx: RequestContext = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });

// ─── Fixtures ────────────────────────────────────────────────────────

function makeMappingKey(over?: Partial<SyncMappingKey>): SyncMappingKey {
    return {
        tenantId: 'tenant-1',
        provider: 'stub',
        localEntityType: 'task',
        localEntityId: 'task-1',
        remoteEntityType: 'issue',
        remoteEntityId: 'PROJ-1',
        ...over,
    };
}

function makeMapping(over?: Partial<SyncMapping>): SyncMapping {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'mapping-1',
        tenantId: 'tenant-1',
        provider: 'stub',
        connectionId: null,
        localEntityType: 'task',
        localEntityId: 'task-1',
        remoteEntityType: 'issue',
        remoteEntityId: 'PROJ-1',
        syncStatus: 'SYNCED',
        lastSyncDirection: 'PUSH',
        conflictStrategy: 'REMOTE_WINS',
        localUpdatedAt: null,
        remoteUpdatedAt: null,
        remoteDataJson: null,
        version: 1,
        errorMessage: null,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
        ...over,
    };
}

/** A store whose every answer is scripted, so the try and the catch can differ. */
function scriptedStore(): jest.Mocked<SyncMappingStore> {
    return {
        findByLocalEntity: jest.fn(async () => null),
        findByRemoteEntity: jest.fn(async () => null),
        findOrCreate: jest.fn(async (_k: SyncMappingKey, d?: SyncMappingCreateData) =>
            makeMapping({ id: 'created', syncStatus: d?.syncStatus ?? 'PENDING', errorMessage: d?.errorMessage ?? null }),
        ),
        updateStatus: jest.fn(async (id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate) =>
            makeMapping({ id, syncStatus: status, errorMessage: extra?.errorMessage ?? null }),
        ),
    } as unknown as jest.Mocked<SyncMappingStore>;
}

class StubClient extends BaseIntegrationClient<{ token: string }> {
    readonly providerId = 'stub';
    readonly displayName = 'Stub';
    created: Record<string, unknown>[] = [];
    updated: Array<{ id: string; changes: Record<string, unknown> }> = [];

    async testConnection(): Promise<ConnectionTestResult> { return { ok: true, message: 'ok' }; }
    async getRemoteObject(remoteId: string): Promise<RemoteObject | null> { return { remoteId, data: {} }; }
    async listRemoteObjects(_q?: RemoteListQuery): Promise<RemoteListResult> { return { items: [], total: 0 }; }
    async createRemoteObject(data: Record<string, unknown>): Promise<RemoteObject> {
        this.created.push(data);
        return { remoteId: 'remote-new', data };
    }
    async updateRemoteObject(remoteId: string, changes: Record<string, unknown>): Promise<RemoteObject> {
        this.updated.push({ id: remoteId, changes });
        return { remoteId, data: changes };
    }
}

class StubMapper extends BaseFieldMapper {
    protected readonly fieldMappings: FieldMappings = { title: 'summary', status: 'status' };
    protected transformToRemote(_f: string, v: unknown) { return v; }
    protected transformToLocal(_f: string, v: unknown) { return v; }
}

class SpyLogger implements SyncEventLogger {
    events: SyncEvent[] = [];
    log(e: SyncEvent) { this.events.push(e); }
}

/**
 * Overrides only what the base class demands. Notably it does NOT override
 * `getRemoteEntityType`, so the base default is what a webhook lookup uses.
 */
class StubOrchestrator extends BaseSyncOrchestrator {
    readonly client = new StubClient({ token: 't' });
    readonly mapper = new StubMapper();
    localData: Record<string, unknown> | null = null;
    applyThrows: Error | null = null;

    constructor(store: SyncMappingStore, logger?: SyncEventLogger) {
        super({ provider: 'stub', store, logger });
    }

    protected resolveClient() { return this.client; }
    protected resolveMapper() { return this.mapper; }

    protected async applyLocalChanges(
        _c: RequestContext, _t: string, _i: string, data: Record<string, unknown>,
    ): Promise<string[]> {
        if (this.applyThrows) throw this.applyThrows;
        return Object.keys(data);
    }
    protected async getLocalData(): Promise<Record<string, unknown> | null> { return this.localData; }
    protected extractRemoteId(p: Record<string, unknown>): string | null {
        return ((p.issue as Record<string, unknown>)?.key as string) ?? null;
    }
    protected extractRemoteData(p: Record<string, unknown>): Record<string, unknown> | null {
        return (p.issue as Record<string, unknown>) ?? null;
    }
}

/**
 * A provider that detects a PUSH-side conflict.
 *
 * The base `checkForConflict` only ever raises a conflict for `direction ===
 * 'PULL'`, so the whole PUSH conflict-resolution block in `push()` is reached
 * exclusively through a subclass override — which is why `checkForConflict` is
 * a public overridable method rather than a private helper. This double is that
 * subclass, and the tests below are the only thing asserting that the block
 * behaves the way `pull()`'s equivalent block does.
 */
class PushConflictOrchestrator extends StubOrchestrator {
    conflict: ConflictCheckResult = { hasConflict: false };
    async checkForConflict(): Promise<ConflictCheckResult> { return this.conflict; }
}

function details(over?: Partial<ConflictDetails>): ConflictDetails {
    return {
        reason: 'Both local and remote were modified since last sync',
        strategy: 'MANUAL',
        localData: { title: 'local' },
        remoteData: { summary: 'remote' },
        lastSyncedRemoteData: null,
        conflictingFields: ['title'],
        ...over,
    } as ConflictDetails;
}

// ═════════════════════════════════════════════════════════════════════

describe('push resolves a provider-detected conflict before touching the remote', () => {
    let store: jest.Mocked<SyncMappingStore>;
    let logger: SpyLogger;
    let orch: PushConflictOrchestrator;

    beforeEach(() => {
        store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(makeMapping());
        logger = new SpyLogger();
        orch = new PushConflictOrchestrator(store, logger);
    });

    const push = () => orch.push({
        ctx,
        mappingKey: makeMappingKey(),
        localData: { title: 'local' },
        changedFields: ['title'],
        localUpdatedAt: new Date('2026-02-01'),
    });

    it('MANUAL parks the mapping in CONFLICT and pushes nothing', async () => {
        orch.conflict = { hasConflict: true, details: details({ strategy: 'MANUAL' }) };

        const r = await push();

        expect(r).toMatchObject({ success: false, action: 'conflict', direction: 'PUSH' });
        expect(r.conflict?.reason).toBe('Both local and remote were modified since last sync');
        expect(store.updateStatus).toHaveBeenCalledWith('mapping-1', 'CONFLICT', {
            errorMessage: 'Both local and remote were modified since last sync',
        });
        // The whole point of parking: the remote is NOT overwritten while a
        // human is still deciding which side is right.
        expect(orch.client.created).toHaveLength(0);
        expect(orch.client.updated).toHaveLength(0);
        expect(logger.events.map((e) => e.action)).toEqual(['conflict']);
    });

    it('REMOTE_WINS skips the push and records the direction as PULL', async () => {
        // Recording PULL is what stops the next push seeing "we pushed last" and
        // concluding there is nothing to reconcile.
        orch.conflict = { hasConflict: true, details: details({ strategy: 'REMOTE_WINS' }) };

        const r = await push();

        expect(r).toMatchObject({ success: true, action: 'skipped', direction: 'PUSH' });
        expect(store.updateStatus).toHaveBeenCalledWith(
            'mapping-1',
            'SYNCED',
            expect.objectContaining({ lastSyncDirection: 'PULL' }),
        );
        expect(orch.client.updated).toHaveLength(0);
    });

    it('LOCAL_WINS falls through and DOES overwrite the remote', async () => {
        orch.conflict = { hasConflict: true, details: details({ strategy: 'LOCAL_WINS' }) };

        const r = await push();

        expect(r).toMatchObject({ success: true, action: 'updated' });
        expect(orch.client.updated).toEqual([{ id: 'PROJ-1', changes: { summary: 'local' } }]);
        expect(store.updateStatus).toHaveBeenCalledWith(
            'mapping-1',
            'SYNCED',
            expect.objectContaining({ lastSyncDirection: 'PUSH', errorMessage: null }),
        );
    });

    it('a conflict flag with NO details is not actionable, so the push proceeds', async () => {
        // `hasConflict` alone cannot be resolved — `resolveConflict` needs the
        // strategy off `details`. Treating the flag as sufficient would send
        // every such mapping to whatever the default arm is; treating it as
        // absent lets the ordinary push run, which is recoverable.
        orch.conflict = { hasConflict: true } as ConflictCheckResult;

        const r = await push();

        expect(r).toMatchObject({ success: true, action: 'updated' });
        expect(orch.client.updated).toHaveLength(1);
    });
});

describe('push with no changed fields sends the whole record', () => {
    it('maps the FULL local object rather than an empty partial', async () => {
        // An empty `changedFields` reaching `toRemotePartial` would produce `{}`
        // — a PATCH that says nothing, reported as a successful sync.
        const store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(makeMapping());
        const orch = new StubOrchestrator(store);

        const r = await orch.push({
            ctx,
            mappingKey: makeMappingKey(),
            localData: { title: 'T', status: 'OPEN' },
            changedFields: [],
            localUpdatedAt: new Date(),
        });

        expect(r.success).toBe(true);
        expect(orch.client.updated).toEqual([{ id: 'PROJ-1', changes: { summary: 'T', status: 'OPEN' } }]);
    });
});

describe('push failure when the mapping cannot be re-found', () => {
    it('creates a FAILED mapping rather than losing the failure', async () => {
        // The catch block re-reads by local key. If the read that failed in the
        // try block is the SAME read, it answers null here too — and without
        // the findOrCreate fallback the orchestrator would throw a second time
        // out of its own error handler.
        const store = scriptedStore();
        store.findByLocalEntity
            .mockRejectedValueOnce(new Error('mapping store unavailable'))
            .mockResolvedValue(null);
        const logger = new SpyLogger();
        const orch = new StubOrchestrator(store, logger);

        const r = await orch.push({
            ctx,
            mappingKey: makeMappingKey(),
            localData: { title: 'T' },
            changedFields: ['title'],
            localUpdatedAt: new Date(),
        });

        expect(r).toMatchObject({
            success: false,
            action: 'error',
            direction: 'PUSH',
            errorMessage: 'mapping store unavailable',
        });
        expect(store.findOrCreate).toHaveBeenCalledWith(makeMappingKey(), {
            syncStatus: 'FAILED',
            errorMessage: 'mapping store unavailable',
        });
        expect(r.mapping.syncStatus).toBe('FAILED');
        expect(logger.events[0]).toMatchObject({ action: 'error', success: false });
    });
});

describe('pull failure falls back through both lookups before creating one', () => {
    const pull = (orch: StubOrchestrator) => orch.pull({
        ctx,
        mappingKey: makeMappingKey(),
        remoteData: { summary: 'R' },
        remoteUpdatedAt: new Date(),
    });

    it('marks the mapping found by REMOTE key when the local key misses', async () => {
        // The webhook path knows only the remote id. A mapping whose local
        // entity was renamed or re-keyed is still findable by remote key, and
        // marking THAT row FAILED is what puts the failure in front of an
        // operator instead of creating a duplicate beside it.
        const store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(null);
        store.findByRemoteEntity.mockResolvedValue(makeMapping({ id: 'by-remote' }));
        const orch = new StubOrchestrator(store);
        orch.applyThrows = new Error('local write rejected');

        const r = await pull(orch);

        expect(store.findByRemoteEntity).toHaveBeenCalledWith('tenant-1', 'stub', 'issue', 'PROJ-1');
        expect(store.updateStatus).toHaveBeenCalledWith('by-remote', 'FAILED', {
            errorMessage: 'local write rejected',
        });
        expect(store.findOrCreate).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ syncStatus: 'FAILED' }),
        );
        expect(r).toMatchObject({ success: false, action: 'error', direction: 'PULL' });
    });

    it('does NOT consult the remote key when the local key already answered', async () => {
        // Ordering matters: the local lookup matches the mapping created at the
        // top of the try block, so a second query is wasted work on the hot
        // failure path.
        const store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(makeMapping({ id: 'by-local' }));
        const orch = new StubOrchestrator(store);
        orch.applyThrows = new Error('local write rejected');

        await pull(orch);

        expect(store.findByRemoteEntity).not.toHaveBeenCalled();
        expect(store.updateStatus).toHaveBeenCalledWith('by-local', 'FAILED', {
            errorMessage: 'local write rejected',
        });
    });

    it('creates a FAILED mapping when neither key finds one', async () => {
        const store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(null);
        store.findByRemoteEntity.mockResolvedValue(null);
        const orch = new StubOrchestrator(store);
        orch.applyThrows = new Error('local write rejected');

        const r = await pull(orch);

        expect(store.findOrCreate).toHaveBeenLastCalledWith(makeMappingKey(), {
            syncStatus: 'FAILED',
            errorMessage: 'local write rejected',
        });
        expect(r.mapping.syncStatus).toBe('FAILED');
    });

    it('stringifies a non-Error throw rather than reporting "undefined"', async () => {
        const store = scriptedStore();
        store.findByLocalEntity.mockResolvedValue(makeMapping());
        const orch = new StubOrchestrator(store);
        // eslint-disable-next-line no-throw-literal -- deliberately not an Error
        orch.applyThrows = 'remote closed the connection' as unknown as Error;

        const r = await pull(orch);

        expect(r.errorMessage).toBe('remote closed the connection');
    });
});

describe('handleWebhookEvent declines what it cannot map', () => {
    let store: jest.Mocked<SyncMappingStore>;
    let logger: SpyLogger;
    let orch: StubOrchestrator;

    beforeEach(() => {
        jest.clearAllMocks();
        store = scriptedStore();
        logger = new SpyLogger();
        orch = new StubOrchestrator(store, logger);
    });

    it('reports a deletion for an unmapped record as processed-but-zero', async () => {
        // `processed: true` is right — the event WAS understood — but syncCount
        // must stay 0 and the reason must say why, or a delete for a record we
        // never mapped is indistinguishable from one we cleaned up.
        store.findByRemoteEntity.mockResolvedValue(null);

        const r = await orch.handleWebhookEvent({
            ctx, provider: 'stub', eventType: 'deleted', payload: { issue: { key: 'PROJ-9' } },
        });

        expect(r).toEqual({
            processed: true,
            syncCount: 0,
            results: [],
            reason: 'No mapping found for deleted remote object',
        });
        expect(store.updateStatus).not.toHaveBeenCalled();
        // Nothing happened, so nothing is logged — an audit row here would
        // claim a mapping was touched.
        expect(logger.events).toHaveLength(0);
    });

    it('marks a mapped record STALE and counts it', async () => {
        store.findByRemoteEntity.mockResolvedValue(makeMapping({ id: 'gone' }));

        const r = await orch.handleWebhookEvent({
            ctx, provider: 'stub', eventType: 'deleted', payload: { issue: { key: 'PROJ-1' } },
        });

        expect(r).toMatchObject({ processed: true, syncCount: 1 });
        expect(r.reason).toBeUndefined();
        expect(store.updateStatus).toHaveBeenCalledWith('gone', 'STALE', {
            errorMessage: 'Remote object was deleted',
        });
    });

    it('declines a payload whose entity body cannot be extracted', async () => {
        // The id parsed but the body did not — the shape a provider sends when
        // the hook carries only a reference. Pulling with `{}` would map to an
        // empty local patch and report a successful sync that erased nothing
        // and confirmed nothing.
        //
        // Checked BEFORE the mapping lookup, so a body-less payload is refused
        // as a payload problem rather than as an unmapped record — the two need
        // different operator responses.
        store.findByRemoteEntity.mockResolvedValue(makeMapping());
        const bodyless = new StubOrchestrator(store, logger);
        (bodyless as any).extractRemoteData = () => null;

        const r = await bodyless.handleWebhookEvent({
            ctx, provider: 'stub', eventType: 'updated', payload: { issue: { key: 'PROJ-1' } },
        });

        expect(r).toEqual({
            processed: false,
            syncCount: 0,
            results: [],
            reason: 'Could not extract remote data from updated payload',
        });
        expect(enqueue).not.toHaveBeenCalled();
        expect(store.findByRemoteEntity).not.toHaveBeenCalled();
    });

    it('uses the base getRemoteEntityType when a provider does not override it', async () => {
        // `StubOrchestrator` deliberately leaves it alone. The default feeds the
        // mapping lookup, so a provider that forgets to override it silently
        // queries a remote type nothing was ever stored under.
        store.findByRemoteEntity.mockResolvedValue(null);

        await orch.handleWebhookEvent({
            ctx, provider: 'stub', eventType: 'deleted', payload: { issue: { key: 'PROJ-1' } },
        });

        expect(store.findByRemoteEntity).toHaveBeenCalledWith('tenant-1', 'stub', 'default', 'PROJ-1');
    });

    it('prefers the CALLER-supplied connectionId over the one on the mapping', async () => {
        // A webhook arrives on a specific connection. If two connections map the
        // same remote entity, deferring to the mapping's stored id would run the
        // pull against the wrong credential.
        store.findByRemoteEntity.mockResolvedValue(makeMapping({ connectionId: 'conn-stored' }));

        await orch.handleWebhookEvent({
            ctx,
            provider: 'stub',
            eventType: 'updated',
            payload: { issue: { key: 'PROJ-1', summary: 'R' } },
            connectionId: 'conn-from-webhook',
        });

        expect(enqueue).toHaveBeenCalledWith(
            'sync-pull',
            expect.objectContaining({
                mappingKey: expect.objectContaining({ connectionId: 'conn-from-webhook' }),
            }),
            expect.objectContaining({ jobId: expect.stringContaining('sync-pull:tenant-1:stub:') }),
        );
    });

    it('falls back to the mapping’s connectionId when the caller supplies none', async () => {
        store.findByRemoteEntity.mockResolvedValue(makeMapping({ connectionId: 'conn-stored' }));

        await orch.handleWebhookEvent({
            ctx, provider: 'stub', eventType: 'updated', payload: { issue: { key: 'PROJ-1', summary: 'R' } },
        });

        expect(enqueue).toHaveBeenCalledWith(
            'sync-pull',
            expect.objectContaining({
                mappingKey: expect.objectContaining({ connectionId: 'conn-stored' }),
            }),
            expect.anything(),
        );
    });
});

describe('checkForConflict does not raise a conflict nothing can resolve', () => {
    it('returns hasConflict=false when both sides moved but no MAPPED field differs', async () => {
        // Both timestamps and the cached remote blob say "both sides changed",
        // but every difference is in a field this mapper does not carry. A
        // conflict with an empty field list would park the mapping in CONFLICT
        // for a human who would find nothing to compare.
        const store = scriptedStore();
        const orch = new StubOrchestrator(store);

        const mapping = makeMapping({
            syncStatus: 'SYNCED',
            lastSyncedAt: new Date('2026-01-01'),
            localUpdatedAt: new Date('2026-02-01'),
            // Differs from the incoming remote only in an unmapped key.
            remoteDataJson: { summary: 'same', status: 'OPEN', sprint: 'S1' },
        });

        const r: ConflictCheckResult = await orch.checkForConflict(
            mapping,
            { title: 'same', status: 'OPEN' },
            'PULL' as SyncDirection,
            { summary: 'same', status: 'OPEN', sprint: 'S2' },
        );

        expect(r.hasConflict).toBe(false);
        expect(r.details).toBeUndefined();
    });

    it('DOES raise one when a mapped field differs', async () => {
        // The companion case, so the assertion above is a discrimination rather
        // than a function that always answers false.
        const store = scriptedStore();
        const orch = new StubOrchestrator(store);

        const r = await orch.checkForConflict(
            makeMapping({
                syncStatus: 'SYNCED',
                lastSyncedAt: new Date('2026-01-01'),
                localUpdatedAt: new Date('2026-02-01'),
                remoteDataJson: { summary: 'old' },
            }),
            { title: 'local edit' },
            'PULL' as SyncDirection,
            { summary: 'remote edit' },
        );

        expect(r.hasConflict).toBe(true);
        expect(r.details?.conflictingFields).toEqual(['title']);
    });
});
