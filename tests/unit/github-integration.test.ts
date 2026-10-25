/**
 * GitHub Integration — End-to-End Provider Tests
 *
 * Verifies the full migrated GitHub provider through the new architecture:
 *   1. Provider folder structure (barrel export)
 *   2. Registry resolves provider correctly
 *   3. Client + Mapper work through the registry factory
 *   4. Sync orchestrator integrates with the provider
 *   5. Webhook path still functions
 *   6. Legacy compatibility paths still work
 *   7. No regression in existing integration behavior
 */
import {
    GitHubClient,
    GitHubBranchProtectionMapper,
    GitHubSyncOrchestrator,
    GitHubProvider,
    evaluateBranchProtection,
    fetchBranchProtection,
    fetchBranchRules,
} from '@/app-layer/integrations/providers/github';
import type { GitHubConnectionConfig } from '@/app-layer/integrations/providers/github';
import type { GitHubLocalStore } from '@/app-layer/integrations/providers/github/sync';
import type { SyncMapping, SyncMappingKey, SyncMappingCreateData, SyncMappingStatusUpdate } from '@/app-layer/integrations/sync-types';
import type { SyncMappingStore, SyncEventLogger } from '@/app-layer/integrations/sync-orchestrator';
import type { SyncEvent } from '@/app-layer/integrations/sync-types';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { integrationEvidenceText } from '@/app-layer/integrations/evidence-text';

jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'mock-job' }),
}));
import { enqueue } from '@/app-layer/jobs/queue';
export const mockCtx: RequestContext = {
    tenantId: 'tenant-1',
    userId: 'system',
    requestId: 'req-1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('ADMIN'),
};

// ─── Test Fixtures ───────────────────────────────────────────────────

/** In-memory sync mapping store */
class InMemoryMappingStore implements SyncMappingStore {
    private mappings = new Map<string, SyncMapping>();
    private nextId = 1;

    async findByLocalEntity(
        tenantId: string, provider: string, localEntityType: string, localEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.localEntityType === localEntityType && m.localEntityId === localEntityId) {
                return m;
            }
        }
        return null;
    }

    async findByRemoteEntity(
        tenantId: string, provider: string, remoteEntityType: string, remoteEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.remoteEntityType === remoteEntityType && m.remoteEntityId === remoteEntityId) {
                return m;
            }
        }
        return null;
    }

    async findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping> {
        const existing = await this.findByLocalEntity(
            key.tenantId, key.provider, key.localEntityType, key.localEntityId,
        );
        if (existing) {
            return existing;
        }
        const now = new Date();
        const id = `mapping-${this.nextId++}`;
        const mapping: SyncMapping = {
            id, tenantId: key.tenantId, provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING', lastSyncDirection: null, conflictStrategy: 'REMOTE_WINS',
            localUpdatedAt: null, remoteUpdatedAt: null, remoteDataJson: null,
            version: 1, errorMessage: defaults?.errorMessage ?? null, lastSyncedAt: null,
            createdAt: now, updatedAt: now,
        };
        this.mappings.set(id, mapping);
        return mapping;
    }

    async updateStatus(
        id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        const existing = this.mappings.get(id);
        if (!existing) throw new Error(`Mapping ${id} not found`);
        const updated: SyncMapping = { ...existing, syncStatus: status, updatedAt: new Date() };
        if (extra?.lastSyncDirection !== undefined) updated.lastSyncDirection = extra.lastSyncDirection;
        if (extra?.localUpdatedAt !== undefined) updated.localUpdatedAt = extra.localUpdatedAt;
        if (extra?.remoteUpdatedAt !== undefined) updated.remoteUpdatedAt = extra.remoteUpdatedAt;
        if (extra?.remoteDataJson !== undefined) updated.remoteDataJson = extra.remoteDataJson;
        if (extra?.lastSyncedAt !== undefined) updated.lastSyncedAt = extra.lastSyncedAt;
        if (extra?.version !== undefined) updated.version = extra.version;
        if (extra?.errorMessage !== undefined) updated.errorMessage = extra.errorMessage;
        this.mappings.set(id, updated);
        return updated;
    }
}

/** In-memory local entity store */
class InMemoryLocalStore implements GitHubLocalStore {
    private entities = new Map<string, Record<string, unknown>>();

    async applyChanges(
        _ctx: RequestContext, entityType: string, entityId: string,
        data: Record<string, unknown>,
    ): Promise<string[]> {
        const key = `${entityType}:${entityId}`;
        const existing = this.entities.get(key) ?? {};
        this.entities.set(key, { ...existing, ...data });
        return Object.keys(data);
    }

    async getData(
        _ctx: RequestContext, entityType: string, entityId: string,
    ): Promise<Record<string, unknown> | null> {
        return this.entities.get(`${entityType}:${entityId}`) ?? null;
    }

    setData(entityType: string, entityId: string, data: Record<string, unknown>): void {
        this.entities.set(`${entityType}:${entityId}`, data);
    }
}

class SpyLogger implements SyncEventLogger {
    events: SyncEvent[] = [];
    log(event: SyncEvent) { this.events.push(event); }
}

const TEST_CONFIG: GitHubConnectionConfig = {
    owner: 'acme', repo: 'platform', branch: 'main', token: 'ghp_test',
};

const MAPPING_KEY: SyncMappingKey = {
    tenantId: 'tenant-1', provider: 'github',
    localEntityType: 'control', localEntityId: 'ctrl-1',
    remoteEntityType: 'branch_protection', remoteEntityId: 'main',
};

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('GitHub provider — barrel export', () => {
    test('exports all new-pattern components', () => {
        expect(GitHubClient).toBeDefined();
        expect(GitHubBranchProtectionMapper).toBeDefined();
        expect(GitHubSyncOrchestrator).toBeDefined();
    });

    test('exports legacy provider and helpers', () => {
        expect(GitHubProvider).toBeDefined();
        expect(evaluateBranchProtection).toBeDefined();
        expect(fetchBranchProtection).toBeDefined();
    });
});

describe('GitHub provider — legacy compatibility', () => {
    test('old import path still works', async () => {
        // This simulates what bootstrap.ts and other files do
        const { GitHubProvider: GP } = await import('@/app-layer/integrations/providers/github');
        expect(GP).toBeDefined();
        const provider = new GP();
        expect(provider.id).toBe('github');
        expect(provider.supportedChecks).toContain('branch_protection');
    });

    test('old github-client import path still works', async () => {
        const { GitHubClient: GC } = await import('@/app-layer/integrations/providers/github-client');
        expect(GC).toBeDefined();
    });

    test('old github-mapper import path still works', async () => {
        const { GitHubBranchProtectionMapper: GM } = await import('@/app-layer/integrations/providers/github-mapper');
        expect(GM).toBeDefined();
    });
});

describe('GitHub provider — registry integration', () => {
    test('ProviderRegistry resolves GitHub for automation keys', () => {
        // Trigger side-effect registration
        require('@/app-layer/integrations/bootstrap');
        const { registry } = require('@/app-layer/integrations/registry');
        const resolution = registry.resolveByAutomationKey('github.branch_protection');
        expect(resolution).toBeTruthy();
        expect(resolution.provider.id).toBe('github');
    });

    test('IntegrationRegistry creates GitHubClient from factory', () => {
        const { integrationRegistry } = require('@/app-layer/integrations/registry');
        if (integrationRegistry.has('github')) {
            const client = integrationRegistry.createClient('github', TEST_CONFIG);
            expect(client).toBeInstanceOf(GitHubClient);
            expect(client.providerId).toBe('github');
        }
    });

    test('IntegrationRegistry creates GitHubBranchProtectionMapper from factory', () => {
        const { integrationRegistry } = require('@/app-layer/integrations/registry');
        if (integrationRegistry.has('github')) {
            const mapper = integrationRegistry.createMapper('github');
            expect(mapper).toBeInstanceOf(GitHubBranchProtectionMapper);
        }
    });
});

describe('GitHub provider — client operations', () => {
    function makeMockFetch(status: number, body: unknown): typeof globalThis.fetch {
        return async () => ({
            status,
            ok: status >= 200 && status < 300,
            json: async () => body,
            text: async () => JSON.stringify(body),
        }) as Response;
    }

    test('testConnection reports success', async () => {
        const client = new GitHubClient(TEST_CONFIG, makeMockFetch(200, { full_name: 'acme/platform' }));
        const result = await client.testConnection();
        expect(result.ok).toBe(true);
        expect(result.message).toContain('acme/platform');
    });

    test('testConnection reports auth failure', async () => {
        const client = new GitHubClient(TEST_CONFIG, makeMockFetch(401, {}));
        const result = await client.testConnection();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('expired');
    });

    test('getRemoteObject returns protection data', async () => {
        const protectionData = { required_status_checks: { strict: true, contexts: [] } };
        const client = new GitHubClient(TEST_CONFIG, makeMockFetch(200, protectionData));
        const obj = await client.getRemoteObject('main');
        expect(obj).toBeTruthy();
        expect(obj!.remoteId).toBe('main');
        expect(obj!.data.required_status_checks).toBeTruthy();
    });

    test('getRemoteObject returns null for 404', async () => {
        const client = new GitHubClient(TEST_CONFIG, makeMockFetch(404, {}));
        const obj = await client.getRemoteObject('main');
        expect(obj).toBeNull();
    });
});

describe('GitHub provider — mapper', () => {
    test('maps local to remote', () => {
        const mapper = new GitHubBranchProtectionMapper();
        const remote = mapper.toRemote({
            protectionEnabled: true,
            requiredReviewCount: 2,
            status: 'IMPLEMENTED',
        });
        expect(remote.enabled).toBe(true);
        expect(remote.required_pull_request_reviews).toEqual({
            required_approving_review_count: 2,
        });
        expect(remote.status).toBe('enabled');
    });

    test('maps remote to local', () => {
        const mapper = new GitHubBranchProtectionMapper();
        const local = mapper.toLocal({
            enabled: true,
            required_pull_request_reviews: {
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
                require_code_owner_reviews: false,
            },
            status: 'enabled',
        });
        expect(local.protectionEnabled).toBe(true);
        expect(local.requiredReviewCount).toBe(2);
        expect(local.dismissStaleReviews).toBe(true);
        expect(local.status).toBe('IMPLEMENTED');
    });

    test('round-trip preserves data', () => {
        const mapper = new GitHubBranchProtectionMapper();
        const original = { protectionEnabled: true, status: 'IMPLEMENTED', requiredReviewCount: 1 };
        const remote = mapper.toRemote(original);
        const roundTripped = mapper.toLocal(remote);
        expect(roundTripped.protectionEnabled).toBe(original.protectionEnabled);
        expect(roundTripped.status).toBe(original.status);
        expect(roundTripped.requiredReviewCount).toBe(original.requiredReviewCount);
    });
});

describe('GitHub provider — sync orchestrator', () => {
    let store: InMemoryMappingStore;
    let localStore: InMemoryLocalStore;
    let logger: SpyLogger;
    let orch: GitHubSyncOrchestrator;

    beforeEach(() => {
        store = new InMemoryMappingStore();
        localStore = new InMemoryLocalStore();
        logger = new SpyLogger();

        const mockFetch = async () => ({
            status: 200, ok: true,
            json: async () => ({ required_status_checks: { strict: true, contexts: [] } }),
            text: async () => '{}',
        }) as Response;

        orch = new GitHubSyncOrchestrator({
            config: TEST_CONFIG,
            store,
            localStore,
            logger,
            fetchImpl: mockFetch,
        });
    });

    test('push syncs local data to remote', async () => {
        const result = await orch.push({ ctx: mockCtx,
            mappingKey: MAPPING_KEY,
            localData: { protectionEnabled: true, status: 'IMPLEMENTED' },
            changedFields: ['protectionEnabled'],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(result.direction).toBe('PUSH');
        expect(result.mapping.syncStatus).toBe('SYNCED');
    });

    test('pull applies remote data to local entity', async () => {
        const result = await orch.pull({ ctx: mockCtx,
            mappingKey: MAPPING_KEY,
            remoteData: {
                enabled: true,
                status: 'enabled',
                required_pull_request_reviews: { required_approving_review_count: 2 },
            },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(result.direction).toBe('PULL');

        // Verify local entity was updated
        const localData = await localStore.getData(mockCtx, 'control', 'ctrl-1');
        expect(localData).toBeTruthy();
        expect(localData!.protectionEnabled).toBe(true);
        expect(localData!.requiredReviewCount).toBe(2);
        expect(localData!.status).toBe('IMPLEMENTED');
    });

    test('webhook pull extracts data from branch_protection_rule event', async () => {
        // Pre-create a mapping
        const base = await store.findOrCreate(MAPPING_KEY);
        await store.updateStatus(base.id, 'SYNCED');

        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'github',
            eventType: 'updated',
            payload: {
                rule: {
                    name: 'main',
                    enabled: true,
                    required_status_checks: { strict: true, contexts: ['ci'] },
                },
            },
        });

        expect(result.processed).toBe(true);
        expect(result.syncCount).toBe(1);
        expect(enqueue).toHaveBeenCalled();
    });

    test('webhook handles unknown remote ID gracefully', async () => {
        const result = await orch.handleWebhookEvent({ ctx: mockCtx,
            provider: 'github',
            eventType: 'updated',
            payload: { rule: { name: 'unknown-branch' } },
        });

        expect(result.processed).toBe(false);
        expect(result.reason).toContain('No mapping found');
    });
});

describe('GitHub provider — fetchBranchRules (#3433)', () => {
    const resp = (status: number, body: unknown) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });

    it('404 means NO rulesets apply — an answer, not a failure', async () => {
        const r = await fetchBranchRules('a', 'b', 'main', 't', (async () => resp(404, {})) as never);
        expect(r.rules).toEqual([]);
        expect(r.error).toBeUndefined();
    });

    it('an auth failure yields null — unknown, never zero', async () => {
        const r = await fetchBranchRules('a', 'b', 'main', 't', (async () => resp(403, { message: 'Forbidden' })) as never);
        // The distinction the evaluator depends on: `null`, not `[]`. `[]`
        // would make a scope-less token read as "nothing is configured".
        expect(r.rules).toBeNull();
        expect(r.error).toContain('403');
    });

    it('a thrown fetch yields null too, not an empty list', async () => {
        const r = await fetchBranchRules('a', 'b', 'main', 't', (async () => { throw new Error('ECONNRESET'); }) as never);
        expect(r.rules).toBeNull();
        expect(r.error).toContain('ECONNRESET');
    });

    it('reads the rules-in-effect endpoint, not the rulesets list', async () => {
        let seen = '';
        await fetchBranchRules('acme', 'repo', 'main', 't', (async (u: string) => { seen = u; return resp(200, []); }) as never);
        // `/rules/branches/{branch}` returns org+repo rulesets already merged
        // and filtered to this branch; `/rulesets` would need us to evaluate
        // ref-name conditions ourselves.
        expect(seen).toBe('https://api.github.com/repos/acme/repo/rules/branches/main');
    });

    it('a non-array 200 body does not become a bogus rule list', async () => {
        const r = await fetchBranchRules('a', 'b', 'main', 't', (async () => resp(200, { message: 'nope' })) as never);
        expect(r.rules).toEqual([]);
    });
});

describe('GitHub provider — evaluateBranchProtection (pure function)', () => {
    // ─── #3433 defect 2: rulesets ────────────────────────────────────────
    //
    // Every fixture below is the response observed against
    // RodnaPamet/inflect-compliance main on 2026-10-11, not an invention.

    /** The classic endpoint on a ruleset-governed branch: 200, both keys null. */
    const CLASSIC_NULLS = {
        url: 'https://api.github.com/repos/acme/repo/branches/main/protection',
        required_status_checks: null,
        required_pull_request_reviews: null,
        enforce_admins: { enabled: false },
    };
    /** Ruleset 20952644 "main protection", enforcement active. */
    const LIVE_RULES = [
        { type: 'copilot_code_review', ruleset_id: 19449061, ruleset_source_type: 'Repository' },
        { type: 'deletion', ruleset_id: 20952644, ruleset_source_type: 'Repository' },
        { type: 'non_fast_forward', ruleset_id: 20952644, ruleset_source_type: 'Repository' },
        {
            type: 'required_status_checks',
            ruleset_id: 20952644,
            ruleset_source_type: 'Repository',
            parameters: {
                do_not_enforce_on_create: true,
                strict_required_status_checks_policy: false,
                required_status_checks: [
                    { context: 'Lint' }, { context: 'Typecheck' }, { context: 'Test' },
                    { context: 'Build' }, { context: 'Security' }, { context: 'Ratchets' },
                ],
            },
        },
        { type: 'merge_queue', ruleset_id: 20952644, ruleset_source_type: 'Repository' },
    ];

    it('THE LIVE CASE: a ruleset requirement is not invisible behind classic nulls', () => {
        const before = evaluateBranchProtection('acme', 'repo', 'main', CLASSIC_NULLS, 200);
        // What this reported about our own default branch before the fix.
        expect(before.details.requiredStatusChecks).toBe(false);

        const after = evaluateBranchProtection('acme', 'repo', 'main', CLASSIC_NULLS, 200, LIVE_RULES);
        expect(after.details.requiredStatusChecks).toBe(true);
        // ...and it names the mechanism and the contexts, so a reader knows
        // where to go to change it.
        expect(after.summary).toContain('required via ruleset');
        expect(after.summary).toContain('Lint, Typecheck, Test, Build, Security, Ratchets');
    });

    it('non_fast_forward blocks force-pushes even when classic protection allows them', () => {
        const allowed = { ...CLASSIC_NULLS, allow_force_pushes: { enabled: true } };
        expect(evaluateBranchProtection('acme', 'repo', 'main', allowed, 200).details.allowForcePushes).toBe(true);
        const merged = evaluateBranchProtection('acme', 'repo', 'main', allowed, 200, LIVE_RULES);
        expect(merged.details.allowForcePushes).toBe(false);
        expect(merged.summary).toContain('blocked by ruleset');
    });

    it('a 404 on classic protection is NOT proof of no protection', () => {
        // A branch governed solely by a ruleset. Before the fix this reported
        // "Branch protection is NOT enabled" for a fully governed branch.
        const r = evaluateBranchProtection('acme', 'repo', 'main', null, 404, LIVE_RULES);
        expect(r.details.protectionEnabled).toBe(true);
        expect(r.details.requiredStatusChecks).toBe(true);
        expect(r.details.allowForcePushes).toBe(false);
        expect(r.summary).not.toContain('Branch protection is NOT enabled');
    });

    it('a 404 with NO rulesets really is unprotected', () => {
        const r = evaluateBranchProtection('acme', 'repo', 'main', null, 404, []);
        expect(r.details.protectionEnabled).toBe(false);
        expect(r.details.requiredStatusChecks).toBe(false);
        expect(r.details.allowForcePushes).toBe(true);
        expect(r.status).toBe('FAILED');
    });

    it('UNREADABLE rulesets are unknown, not absent', () => {
        // `null` is "could not look". It must not read as "nothing there" —
        // otherwise a token missing the scope silently downgrades every
        // ruleset-protected branch to unprotected.
        const r = evaluateBranchProtection('acme', 'repo', 'main', CLASSIC_NULLS, 200, null);
        expect(r.details.rulesetsUnread).toBe(true);
        expect(r.summary).toContain('COULD NOT BE READ');
        // ...and it does NOT claim force-pushes are allowed on the strength of
        // a read that failed.
        const r404 = evaluateBranchProtection('acme', 'repo', 'main', null, 404, null);
        expect(r404.summary).toContain('COULD NOT BE READ');
    });

    it('a pull_request rule satisfies the review requirement (shape UNOBSERVED)', () => {
        // Documented but never captured live, so the count is read
        // defensively: presence of the rule is the requirement.
        const withPr = [...LIVE_RULES, { type: 'pull_request', ruleset_id: 20952644, parameters: { required_approving_review_count: 2 } }];
        const r = evaluateBranchProtection('acme', 'repo', 'main', CLASSIC_NULLS, 200, withPr);
        expect(r.details.requiredReviews).toBe(true);
        expect(r.details.reviewCount).toBe(2);
        expect(r.status).toBe('PASSED');
        // ...and with no parameters sent at all, the rule still counts.
        const bare = [...LIVE_RULES, { type: 'pull_request', ruleset_id: 20952644 }];
        expect(evaluateBranchProtection('acme', 'repo', 'main', CLASSIC_NULLS, 200, bare).details.requiredReviews).toBe(true);
    });

    it('classic requirements are unchanged when no rulesets apply', () => {
        const classic = {
            url: 'u',
            required_status_checks: { strict: true, contexts: ['ci'] },
            required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: false },
            enforce_admins: { enabled: true },
        };
        const r = evaluateBranchProtection('acme', 'repo', 'main', classic, 200, []);
        expect(r.status).toBe('PASSED');
        expect(r.summary).toContain('via branch protection');
        expect(r.summary).not.toContain('ruleset');
    });

    test('FAILS when no protection exists', () => {
        const result = evaluateBranchProtection('acme', 'repo', 'main', null, 404);
        expect(result.status).toBe('FAILED');
        expect(result.details.protectionEnabled).toBe(false);
    });

    test('FAILS when reviews OR status checks missing', () => {
        const result = evaluateBranchProtection('acme', 'repo', 'main', {
            url: '',
            required_status_checks: null,
            enforce_admins: { enabled: true },
            required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_reviews: false },
            restrictions: null,
            required_linear_history: null,
            allow_force_pushes: null,
            allow_deletions: null,
        }, 200);
        expect(result.status).toBe('FAILED');
    });

    test('the LIVE shape: omitted keys are absent requirements, not present ones', () => {
        // Captured verbatim from `GET /repos/{owner}/{repo}/branches/main/protection`
        // on a real repository (#3433). Note what is NOT here:
        // `required_status_checks` and `required_pull_request_reviews` are
        // OMITTED, not null — GitHub drops the key when the requirement is not
        // configured.
        //
        // This fixture could not be written before the type made those keys
        // optional, which is why the suite was green while the mapping was
        // wrong: `!== null` read `undefined !== null` as "requirement present".
        const result = evaluateBranchProtection('acme', 'repo', 'main', {
            url: 'https://api.github.com/repos/acme/repo/branches/main/protection',
            enforce_admins: { enabled: false },
            required_linear_history: { enabled: false },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
        }, 200);
        expect(result.details.requiredStatusChecks).toBe(false);
        expect(result.details.requiredReviews).toBe(false);
        expect(result.status).toBe('FAILED');
        // `hasReviews` also writes the evidence SUMMARY, and that is the only
        // place its value is observable on its own — `requiredReviews` is
        // guarded by `reviewCount >= 1`, so a wrong `hasReviews` is invisible
        // there. Without this assertion the `required_pull_request_reviews`
        // half of the fix is untested: reverting it to `!==` reddens nothing.
        // An absent requirement must read as NOT configured, not as
        // "0 reviewer(s)" — which states a requirement of zero rather than none.
        expect(result.summary).toContain('Required reviews: NOT configured');
        expect(result.summary).toContain('Status checks: NOT required');
    });

    test('FAILS with reviews configured but status checks OMITTED', () => {
        // The case the defect actually passed. `requiredReviews` survived by
        // accident — it is `hasReviews && reviewCount >= 1`, and `?? 0` made the
        // verdict right for the wrong reason. `requiredStatusChecks` had no such
        // second term, so an omitted key read as a requirement in force and the
        // whole control PASSED on a branch with no required checks.
        const result = evaluateBranchProtection('acme', 'repo', 'main', {
            url: '',
            enforce_admins: { enabled: true },
            required_pull_request_reviews: {
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
                require_code_owner_reviews: true,
            },
            allow_force_pushes: { enabled: false },
        }, 200);
        expect(result.details.requiredReviews).toBe(true);
        expect(result.details.requiredStatusChecks).toBe(false);
        expect(result.status).toBe('FAILED');
    });

    test('PASSES when reviews AND status checks present', () => {
        const result = evaluateBranchProtection('acme', 'repo', 'main', {
            url: '',
            required_status_checks: { strict: true, contexts: ['ci'] },
            enforce_admins: { enabled: true },
            required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true, require_code_owner_reviews: true },
            restrictions: null,
            required_linear_history: null,
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
        }, 200);
        expect(result.status).toBe('PASSED');
        expect(result.details.reviewCount).toBe(2);
    });
});

describe('GitHub provider — legacy GitHubProvider behavior', () => {
    test('provider ID matches automation key prefix', () => {
        const provider = new GitHubProvider();
        expect(provider.id).toBe('github');
        expect(provider.supportedChecks).toContain('branch_protection');
    });

    test('configSchema has required fields', () => {
        const provider = new GitHubProvider();
        const configKeys = provider.configSchema.configFields.map(f => f.key);
        expect(configKeys).toContain('owner');
        expect(configKeys).toContain('repo');

        const secretKeys = provider.configSchema.secretFields.map(f => f.key);
        expect(secretKeys).toContain('token');
    });

    test('validateConnection rejects missing config', async () => {
        const provider = new GitHubProvider();
        const result = await provider.validateConnection({}, {});
        expect(result.valid).toBe(false);
    });

    test('mapResultToEvidence returns null for ERROR', () => {
        const provider = new GitHubProvider();
        const result = provider.mapResultToEvidence(
            { automationKey: 'github.branch_protection', parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'manual' },
            { status: 'ERROR', summary: 'error', details: {}, errorMessage: 'fail' },
        );
        expect(result).toBeNull();
    });

    test('mapResultToEvidence returns payload for PASSED', () => {
        const provider = new GitHubProvider();
        const result = provider.mapResultToEvidence(
            { automationKey: 'github.branch_protection', parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' },
            { status: 'PASSED', summary: 'all good', details: { repository: 'acme/repo', branch: 'main', protectionEnabled: true, requiredReviews: true, requiredStatusChecks: true, enforceAdmins: true, allowForcePushes: false, reviewCount: 2 } },
        );
        expect(result).toBeTruthy();
        expect(result!.title).toContain('✅');
        expect(result!.type).toBe('CONFIGURATION');
    });

    test('a repository, branch and status-check name from GitHub are stored without their markup', () => {
        // The repository and branch come from the connection and the status
        // check names from GitHub's rulesets API; all three are interpolated
        // into the evidence title and body. The writers store the payload
        // through `integrationEvidenceText`, which must leave none of it live.
        const hostileRules = [{
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'Build<img src=x onerror=alert(1)>' }, { context: 'Lint' }] },
        }, { type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
        const check = evaluateBranchProtection(
            'acme', '<b>repo</b>', 'release/<script>alert(1)</script>1.2', null, 404, hostileRules,
        );
        const payload = new GitHubProvider().mapResultToEvidence(
            { automationKey: 'github.branch_protection', parsed: { provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' },
            check,
        );
        expect(payload).not.toBeNull();

        const stored = integrationEvidenceText(payload!);
        expect(stored.title).toBe('✅ GitHub Branch Protection: acme/repo:release/1.2');
        expect(stored.content).toContain('**Repository:** acme/repo');
        expect(stored.content).toContain('**Branch:** release/1.2');
        expect(stored.content).toContain('required via ruleset (Build, Lint)');
        expect(`${stored.title}\n${stored.content}`).not.toMatch(/<img|<script|<b>|onerror/i);
    });
});
