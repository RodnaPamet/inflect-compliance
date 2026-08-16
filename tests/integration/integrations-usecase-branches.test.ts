/**
 * Branch-coverage integration test for the integrations usecases —
 * exercises the not-found / permission / validation branches plus the
 * full runAutomationForControl execution path (PASSED + evidence,
 * FAILED + no evidence, runtime ERROR) using a fake registered
 * provider. Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { registry } from '@/app-layer/integrations/registry';
import type {
    CheckInput,
    CheckResult,
    EvidencePayload,
    ScheduledCheckProvider,
} from '@/app-layer/integrations/types';
import {
    listIntegrationConnections,
    getIntegrationConnection,
    upsertIntegrationConnection,
    removeIntegrationConnection,
    runAutomationForControl,
    handleIncomingWebhook,
    listExecutionsForControl,
    listAvailableAutomationKeys,
    listAvailableProviders,
    updateConnectionTestStatus,
    getIntegrationDiagnostics,
} from '@/app-layer/usecases/integrations';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `intg-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const PROVIDER_ID = `fakeprov${SUITE_TAG.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
// Registered but never given a connection — exercises the
// "no active connection" branch even after other tests create
// connections for PROVIDER_ID.
const NOCONN_PROVIDER_ID = `noconn${SUITE_TAG.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
const CHECK_TYPE = 'check1';

let ownerUserId: string;
let readerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

// ── Fake provider whose runCheck behaviour is driven per-test ──
let nextRun: CheckResult | Error = {
    status: 'PASSED',
    summary: 'ok',
    details: { a: 1 },
};
let nextEvidence: EvidencePayload | null = {
    title: 'evid',
    content: 'body',
    type: 'REPORT',
    category: 'integration',
};

const fakeProvider: ScheduledCheckProvider = {
    id: PROVIDER_ID,
    liveValidation: false,
    displayName: 'Fake Provider',
    description: 'test',
    supportedChecks: [CHECK_TYPE],
    configSchema: { configFields: [], secretFields: [] },
    async validateConnection() {
        return { valid: true };
    },
    async runCheck(_input: CheckInput): Promise<CheckResult> {
        if (nextRun instanceof Error) throw nextRun;
        return nextRun;
    },
    mapResultToEvidence(): EvidencePayload | null {
        return nextEvidence;
    },
};

const noConnProvider: ScheduledCheckProvider = {
    ...fakeProvider,
    id: NOCONN_PROVIDER_ID,
};

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('integrations usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
        registry.register(fakeProvider);
        registry.register(noConnProvider);
    });

    afterAll(async () => {
        registry.unregister(PROVIDER_ID);
        registry.unregister(NOCONN_PROVIDER_ID);
        await globalPrisma.integrationExecution.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.integrationWebhookEvent.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('read helpers return shapes; not-found + permission branches throw', async () => {
        expect(Array.isArray(await listIntegrationConnections(ctx))).toBe(true);
        await expect(getIntegrationConnection(ctx, 'nope')).rejects.toThrow(/not found/i);
        // pure registry-backed helpers
        expect(Array.isArray(listAvailableAutomationKeys())).toBe(true);
        expect(Array.isArray(listAvailableProviders())).toBe(true);
        expect(listAvailableProviders().some((p) => p.id === PROVIDER_ID)).toBe(true);
        // diagnostics returns the structured shape
        const diag = await getIntegrationDiagnostics(ctx);
        expect(diag.recentExecutions).toBeDefined();
        expect(diag.recentWebhooks).toBeDefined();
        expect(typeof diag.errorCount24h).toBe('number');
    });

    it('upsert: forbidden for non-admin, badRequest for unknown provider', async () => {
        await expect(
            upsertIntegrationConnection(reader, { provider: PROVIDER_ID, name: 'x' }),
        ).rejects.toThrow(/admin only/i);
        await expect(
            upsertIntegrationConnection(ctx, { provider: 'no-such-provider', name: 'x' }),
        ).rejects.toThrow(/unknown provider/i);
        await expect(
            upsertIntegrationConnection(ctx, { provider: PROVIDER_ID, name: 'x', id: 'missing-id' }),
        ).rejects.toThrow(/not found/i);
    });

    it('upsert create + update; updateConnectionTestStatus', async () => {
        const created = await upsertIntegrationConnection(ctx, {
            provider: PROVIDER_ID,
            name: 'conn-a',
            configJson: { region: 'eu' },
            secrets: { token: 'sek' },
        });
        expect(created.id).toBeTruthy();

        const updated = await upsertIntegrationConnection(ctx, {
            id: created.id,
            provider: PROVIDER_ID,
            name: 'conn-a-renamed',
            configJson: { region: 'us' },
            secrets: { token: 'sek2' },
            isEnabled: true,
        });
        expect(updated.name).toBe('conn-a-renamed');

        const res = await updateConnectionTestStatus(ctx, created.id, 'OK');
        expect(res.count).toBe(1);
    });

    it('remove: forbidden for non-admin, notFound for bad id, ok for real id', async () => {
        await expect(removeIntegrationConnection(reader, 'x')).rejects.toThrow(/admin only/i);
        await expect(removeIntegrationConnection(ctx, 'missing')).rejects.toThrow(/not found/i);
        const conn = await upsertIntegrationConnection(ctx, { provider: PROVIDER_ID, name: 'conn-del' });
        const out = await removeIntegrationConnection(ctx, conn.id);
        expect(out.ok).toBe(true);
    });

    it('runAutomationForControl: not-found / no-key / no-provider / no-connection branches', async () => {
        await expect(runAutomationForControl(ctx, 'nope')).rejects.toThrow(/control not found/i);

        const noKey = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'NK-1', name: 'no key' },
        });
        await expect(runAutomationForControl(ctx, noKey.id)).rejects.toThrow(/no automationkey/i);

        const badKey = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'BK-1', name: 'bad key', automationKey: 'ghost.thing' },
        });
        await expect(runAutomationForControl(ctx, badKey.id)).rejects.toThrow(/no provider for automationkey/i);

        // valid key + provider but no active connection (dedicated provider)
        const noConn = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'NC-1', name: 'no conn', automationKey: `${NOCONN_PROVIDER_ID}.${CHECK_TYPE}` },
        });
        await expect(runAutomationForControl(ctx, noConn.id)).rejects.toThrow(/no active connection/i);
    });

    it('runAutomationForControl: PASSED+evidence, FAILED+no-evidence, runtime ERROR', async () => {
        await upsertIntegrationConnection(ctx, {
            provider: PROVIDER_ID,
            name: 'run-conn',
            secrets: { token: 'sek' },
            isEnabled: true,
        });
        const control = await globalPrisma.control.create({
            data: {
                tenantId: TENANT_ID,
                code: 'RUN-1',
                name: 'runnable',
                automationKey: `${PROVIDER_ID}.${CHECK_TYPE}`,
            },
        });

        // PASSED + evidence payload → evidence row created.
        nextRun = { status: 'PASSED', summary: 'pass', details: { ok: true } };
        nextEvidence = { title: 'auto', content: 'c', type: 'REPORT', category: 'integration' };
        const passed = await runAutomationForControl(ctx, control.id, { triggeredBy: 'manual' });
        expect(passed.execution.status).toBe('PASSED');
        expect(passed.execution.evidenceId).toBeTruthy();

        // FAILED but mapResultToEvidence returns null → no evidence.
        nextRun = { status: 'FAILED', summary: 'fail', details: {} };
        nextEvidence = null;
        const failed = await runAutomationForControl(ctx, control.id, { triggeredBy: 'scheduled' });
        expect(failed.execution.status).toBe('FAILED');
        expect(failed.execution.evidenceId).toBeUndefined();

        // runCheck throws → ERROR branch.
        nextRun = new Error('provider blew up');
        const errored = await runAutomationForControl(ctx, control.id);
        expect(errored.execution.status).toBe('ERROR');
        expect((errored.execution as { errorMessage: string }).errorMessage).toBe('provider blew up');

        // execution history lists what we created.
        const history = await listExecutionsForControl(ctx, control.id, { limit: 5 });
        expect(history.length).toBeGreaterThanOrEqual(3);
    });

    it('handleIncomingWebhook: ignored when no handler for provider', async () => {
        const out = await handleIncomingWebhook(TENANT_ID, 'no-webhook-provider', {
            eventType: 'ping',
            headers: { 'x-test': '1' },
            body: { hello: 'world' },
        });
        expect(out.status).toBe('ignored');
        expect(out.eventId).toBeTruthy();
    });
});
