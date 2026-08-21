/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/integrations.ts
 *
 * Wave 3 of GAP-02. Integration secrets are the keys that unlock
 * external systems (Datadog, Slack, Jira, etc.). A bug in this
 * usecase has three blast radii:
 *   1. Secrets persisted in plaintext (encryption regression).
 *   2. Non-admin users mutating connections (RBAC regression).
 *   3. Provider validation bypass — typo'd provider name silently
 *      attaches a non-functional connection.
 *
 * Behaviours protected:
 *   1. canAdmin gate on upsert / remove.
 *   2. Provider validation rejects unknown providers.
 *   3. Secrets always encrypted via encryptField — plaintext never
 *      reaches the DB column.
 *   4. CREATED / UPDATED / DISABLED audit events.
 *   5. runAutomationForControl: notFound / badRequest paths.
 *   6. handleIncomingWebhook persists raw event; "ignored" if no
 *      handler; status flip to "processed" on the happy path.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/integrations/registry', () => ({
    registry: {
        getProvider: jest.fn(),
        resolveByAutomationKey: jest.fn(),
        getWebhookProvider: jest.fn(),
        listProviders: jest.fn().mockReturnValue([]),
        listAllAutomationKeys: jest.fn().mockReturnValue([]),
    },
}));
// The usecase imports the provider-bootstrap side-effect module (so the registry
// is populated in the request path). Mock it to a no-op here — this unit test
// drives the fully-mocked registry above, and the real bootstrap would call
// `registry.register(...)` on the mock (which has no such method).
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));

jest.mock('@/app-layer/integrations/types', () => ({
    parseAutomationKey: jest.fn(),
    isScheduledCheckProvider: jest.fn(() => true),
}));

jest.mock('@/lib/security/encryption', () => ({
    encryptField: jest.fn((s: string) => `ENC(${s})`),
    decryptField: jest.fn((s: string) => s.replace(/^ENC\((.*)\)$/, '$1')),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        integrationWebhookEvent: {
            create: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    upsertIntegrationConnection,
    removeIntegrationConnection,
    runAutomationForControl,
    handleIncomingWebhook,
    getConnectionsHealth,
} from '@/app-layer/usecases/integrations';
import { runInTenantContext } from '@/lib/db-context';
import { registry } from '@/app-layer/integrations/registry';
import { encryptField } from '@/lib/security/encryption';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetProvider = registry.getProvider as jest.MockedFunction<typeof registry.getProvider>;
const mockResolveKey = registry.resolveByAutomationKey as jest.MockedFunction<typeof registry.resolveByAutomationKey>;
const mockGetWebhookProvider = registry.getWebhookProvider as jest.MockedFunction<typeof registry.getWebhookProvider>;
const mockEncrypt = encryptField as jest.MockedFunction<typeof encryptField>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockWebhookCreate = prisma.integrationWebhookEvent.create as jest.MockedFunction<typeof prisma.integrationWebhookEvent.create>;
const mockWebhookUpdate = prisma.integrationWebhookEvent.update as jest.MockedFunction<typeof prisma.integrationWebhookEvent.update>;

beforeEach(() => {
    jest.clearAllMocks();
    // Opaque encrypt — the assertion below ("plaintext never reaches
    // the DB") would be tautological if the mock leaked the input back
    // into its output.
    mockEncrypt.mockImplementation(() => 'ENCRYPTED_BLOB_OPAQUE');
});

describe('upsertIntegrationConnection — RBAC + secret encryption', () => {
    const validInput = {
        provider: 'datadog',
        name: 'prod-datadog',
        configJson: { region: 'us1' },
        secrets: { apiKey: 'secret-api-key', appKey: 'secret-app-key' },
    };

    it('rejects EDITOR (canAdmin gate)', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        await expect(
            upsertIntegrationConnection(makeRequestContext('EDITOR'), validInput),
        ).rejects.toThrow(/Admin only/);
    });

    it('rejects READER + AUDITOR', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        await expect(
            upsertIntegrationConnection(makeRequestContext('READER'), validInput),
        ).rejects.toThrow();
        await expect(
            upsertIntegrationConnection(makeRequestContext('AUDITOR'), validInput),
        ).rejects.toThrow();
    });

    it('rejects unknown provider with badRequest', async () => {
        mockGetProvider.mockReturnValue(undefined);
        await expect(
            upsertIntegrationConnection(makeRequestContext('ADMIN'), {
                provider: 'typo-provider', name: 'x',
            }),
        ).rejects.toThrow(/Unknown provider/);
        // Regression: a typo'd provider name silently saved would create
        // a "ghost" connection that never executes — admin would think
        // the integration was wired and miss real failures.
    });

    it('encrypts secrets via encryptField (plaintext never reaches DB)', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        let createArgs: any;
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockImplementation((args: any) => {
                        createArgs = args;
                        return Promise.resolve({ id: 'conn-1', provider: 'datadog', name: 'prod-datadog' });
                    }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), validInput);

        // The encryptField is called with a JSON string of the secrets.
        expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(validInput.secrets));
        // Regression: a refactor that persisted `secrets` directly
        // would write API keys in plaintext to the DB column. We assert
        // the opaque blob landed AND the plaintext does not.
        expect(createArgs.data.secretEncrypted).toBe('ENCRYPTED_BLOB_OPAQUE');
        expect(JSON.stringify(createArgs.data)).not.toContain('secret-api-key');
        expect(JSON.stringify(createArgs.data)).not.toContain('secret-app-key');
    });

    it('omits encryption call when no secrets are provided', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockResolvedValue({ id: 'c1' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog',
            name: 'prod',
            configJson: {},
        });

        expect(mockEncrypt).not.toHaveBeenCalled();
    });

    it('emits CREATED audit on new connection', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    create: jest.fn().mockResolvedValue({ id: 'c1', provider: 'datadog' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), validInput);

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_CREATED' }),
        );
    });

    it('emits UPDATED audit when id is provided + connection exists', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'c1' }),
                    update: jest.fn().mockResolvedValue({ id: 'c1' }),
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            ...validInput,
            id: 'c1',
        });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_UPDATED' }),
        );
    });

    it('throws notFound when updating a connection that is not in the tenant', async () => {
        mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    update: jest.fn(),
                },
            } as never),
        );

        await expect(
            upsertIntegrationConnection(makeRequestContext('ADMIN'), {
                ...validInput,
                id: 'tenant-B-conn',
            }),
        ).rejects.toThrow(/not found/);
        // Regression: a missing tenantId on the WHERE would let an admin
        // in tenant A overwrite a connection in tenant B by id.
    });
});

describe('removeIntegrationConnection', () => {
    it('rejects EDITOR (canAdmin gate)', async () => {
        await expect(
            removeIntegrationConnection(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow();
    });

    it('throws notFound on cross-tenant id', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );

        await expect(
            removeIntegrationConnection(makeRequestContext('ADMIN'), 'tenant-B-conn'),
        ).rejects.toThrow(/not found/);
    });

    it('soft-disables (isEnabled=false) and emits DISABLED audit', async () => {
        let updateArgs: any;
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', provider: 'datadog', name: 'prod',
                    }),
                    update: jest.fn().mockImplementation((args: any) => {
                        updateArgs = args;
                        return Promise.resolve({});
                    }),
                },
            } as never),
        );

        await removeIntegrationConnection(makeRequestContext('ADMIN'), 'c1');

        expect(updateArgs.data.isEnabled).toBe(false);
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'INTEGRATION_CONNECTION_DISABLED' }),
        );
    });

    it('reports the STRUCTURED operation as disabled, agreeing with the action', async () => {
        // The gap this closes: the assertion above pinned the action name and
        // the summary said "Disabled integration", while `detailsJson.operation`
        // said 'deleted' — and that is the half a machine reads. Epic C.4 ships
        // only `detailsJson` to the audit stream and drops free-text `details`,
        // so the SIEM was told the connection was deleted and the only surface
        // saying otherwise was the one no consumer sees. Asserting the action
        // alone stayed green through it.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', provider: 'datadog', name: 'prod',
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
            } as never),
        );

        await removeIntegrationConnection(makeRequestContext('ADMIN'), 'c1');

        const payload = mockLog.mock.calls.at(-1)?.[2] as {
            detailsJson?: { operation?: string };
        };
        expect(payload.detailsJson?.operation).toBe('disabled');
        expect(payload.detailsJson?.operation).not.toBe('deleted');
    });
});

describe('runAutomationForControl — failure paths', () => {
    it('throws notFound when the control does not exist', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: { findFirst: jest.fn().mockResolvedValue(null) },
            } as never),
        );

        await expect(
            runAutomationForControl(makeRequestContext('EDITOR'), 'missing'),
        ).rejects.toThrow(/Control not found/);
    });

    it('throws badRequest when the control has no automationKey', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: null, tenantId: 'tenant-1',
                    }),
                },
            } as never),
        );

        await expect(
            runAutomationForControl(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/no automationKey/);
    });

    it('throws badRequest when no provider matches the automationKey', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: 'datadog:no-such-check', tenantId: 'tenant-1',
                    }),
                },
            } as never),
        );
        mockResolveKey.mockReturnValue(null);

        await expect(
            runAutomationForControl(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/No provider/);
    });

    it('throws badRequest when no active connection exists for the resolved provider', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                control: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 'c1', automationKey: 'datadog:check', tenantId: 'tenant-1', name: 'X',
                    }),
                },
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            } as never),
        );
        mockResolveKey.mockReturnValue({
            provider: { runCheck: jest.fn(), mapResultToEvidence: jest.fn() } as any,
            parsed: { provider: 'datadog' } as any,
        } as never);

        await expect(
            runAutomationForControl(makeRequestContext('EDITOR'), 'c1'),
        ).rejects.toThrow(/No active connection/);
    });
});

describe('handleIncomingWebhook', () => {
    it('persists the raw event row before doing anything else', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue({} as never);
        mockWebhookUpdate.mockResolvedValueOnce({} as never);

        await handleIncomingWebhook('tenant-1', 'datadog', {
            eventType: 'alert',
            headers: { 'x-source': 'datadog' },
            body: { id: 'a1' },
        });

        // Regression: any refactor that processed BEFORE persisting the
        // event row would lose the audit trail on early errors — we
        // would not be able to replay or debug a webhook that crashed
        // mid-flight.
        expect(mockWebhookCreate).toHaveBeenCalled();
        const createArgs = mockWebhookCreate.mock.calls[0][0] as any;
        expect(createArgs.data.status).toBe('received');
        expect(createArgs.data.provider).toBe('datadog');
    });

    it('marks the event "ignored" when no webhook provider is registered', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue(null);

        const result = await handleIncomingWebhook('tenant-1', 'unknown-provider', {
            headers: {}, body: {},
        });

        expect(result.status).toBe('ignored');
        expect(mockWebhookUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'evt-1' },
                data: expect.objectContaining({ status: 'ignored' }),
            }),
        );
    });

    it('marks the event "processed" on the happy path', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-1' } as never);
        mockGetWebhookProvider.mockReturnValue({} as never);

        const result = await handleIncomingWebhook('tenant-1', 'datadog', {
            headers: {}, body: {},
        });

        expect(result.status).toBe('processed');
    });
});

// ─── GAP-3 — per-connection freshness (admin health view) ───

describe('getConnectionsHealth', () => {
    const NOW = 1_700_000_000_000;
    const minsAgo = (m: number) => new Date(NOW - m * 60_000);
    let realNow: () => number;

    beforeEach(() => {
        realNow = Date.now;
        Date.now = () => NOW;
    });
    afterEach(() => {
        Date.now = realNow;
    });

    it('returns empty when there are no enabled connections', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: { findMany: jest.fn().mockResolvedValue([]) },
                integrationExecution: { groupBy: jest.fn() },
            } as never),
        );
        const res = await getConnectionsHealth(makeRequestContext('ADMIN'));
        expect(res.connections).toEqual([]);
        expect(res.staleThresholdSeconds).toBeGreaterThan(0);
    });

    it('flags a connection with no recent success as stale, a recent one as fresh', async () => {
        const groupBy = jest.fn().mockResolvedValue([
            { connectionId: 'fresh', _max: { completedAt: minsAgo(10), executedAt: minsAgo(11) } },
            // stale: last success 5 days ago (> 48h threshold)
            { connectionId: 'stale', _max: { completedAt: minsAgo(60 * 24 * 5), executedAt: null } },
        ]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findMany: jest.fn().mockResolvedValue([
                        { id: 'fresh', provider: 'okta', name: 'Okta', createdAt: minsAgo(10_000), lastTestedAt: null, lastTestStatus: null },
                        { id: 'stale', provider: 'aws', name: 'AWS', createdAt: minsAgo(10_000), lastTestedAt: null, lastTestStatus: null },
                        { id: 'never', provider: 'gcp', name: 'GCP', createdAt: minsAgo(10_000), lastTestedAt: null, lastTestStatus: null },
                    ]),
                },
                integrationExecution: { groupBy },
            } as never),
        );
        const res = await getConnectionsHealth(makeRequestContext('ADMIN'));
        const byId = Object.fromEntries(res.connections.map((c) => [c.connectionId, c]));
        expect(byId.fresh.isStale).toBe(false);
        expect(byId.fresh.hasEverSucceeded).toBe(true);
        expect(byId.stale.isStale).toBe(true);
        // never-succeeded → stale + null lastSuccessAt
        expect(byId.never.isStale).toBe(true);
        expect(byId.never.hasEverSucceeded).toBe(false);
        expect(byId.never.lastSuccessAt).toBeNull();
        expect(res.staleCount).toBe(2);
    });
});
