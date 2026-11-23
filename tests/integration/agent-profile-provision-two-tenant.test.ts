/**
 * `AgentProfileProvision` under two tenants (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165): through the engine's real
 * store, with RLS live (`runInTenantContext` binds each tenant), tenant B
 * cannot read, find or write anything of tenant A's provisions, and B's run
 * never sees A's Anthropic workspace connection or its key.
 *
 * Also the connection secret's shape at rest: the key the store decrypts is
 * ciphertext in the row.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    readConnectionEnvironment,
    readProfileAgent,
    readProvision,
    readWorkspaceConnection,
    recordProvision,
} from '@/lib/agentic/managed-agents/store';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { encryptField } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ap2t-${randomUUID().slice(0, 8)}`;
const A = `t-${TAG}-a`;
const B = `t-${TAG}-b`;
const ctxOf = (tenantId: string) => makeRequestContext('OWNER', { tenantId, role: 'OWNER' });

const HASH = 'a'.repeat(64);
const KEY_A = 'sk-ant-tenant-a-workspace-key'; // pragma: allowlist secret -- a placeholder, never sent

describeFn('AgentProfileProvision — tenant isolation', () => {
    let connectionA = '';

    beforeAll(async () => {
        for (const id of [A, B]) {
            await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        connectionA = (
            await globalPrisma.integrationConnection.create({
                data: {
                    tenantId: A,
                    provider: 'anthropic-workspace',
                    name: 'Anthropic workspace',
                    configJson: { workspaceId: 'wrkspc_tenantA', keepSessions: false },
                    secretEncrypted: encryptField(JSON.stringify({ apiKey: KEY_A })),
                },
            })
        ).id;
        await recordProvision(ctxOf(A), {
            profileId: 'profile-a',
            profileVersionId: 'version-a',
            connectionId: connectionA,
            anthropicAgentId: 'agent_a',
            anthropicAgentVersion: 1,
            environmentId: 'env_a',
            systemHash: HASH,
            toolsHash: HASH,
        });
    });

    afterAll(async () => {
        await globalPrisma.agentProfileProvision.deleteMany({ where: { tenantId: { in: [A, B] } } });
        await globalPrisma.integrationConnection.deleteMany({ where: { tenantId: { in: [A, B] } } });
        await deleteAuditRowsForTenants(globalPrisma, [A, B]);
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
        await globalPrisma.$disconnect();
    });

    it('A reads its own provision and connection (positive control)', async () => {
        expect(await readProvision(ctxOf(A), 'version-a', connectionA)).toEqual(
            expect.objectContaining({ anthropicAgentId: 'agent_a', anthropicAgentVersion: 1, environmentId: 'env_a' }),
        );
        expect(await readProfileAgent(ctxOf(A), 'profile-a', connectionA)).toEqual({
            anthropicAgentId: 'agent_a',
            anthropicAgentVersion: 1,
            systemHash: HASH,
            toolsHash: HASH,
        });
        expect(await readConnectionEnvironment(ctxOf(A), connectionA)).toBe('env_a');
        const read = await readWorkspaceConnection(ctxOf(A));
        expect(read).toEqual({ ok: true, connection: { connectionId: connectionA, workspaceId: 'wrkspc_tenantA', keepSessions: false, apiKey: KEY_A } });
    });

    it("B's reads of A's ids find nothing", async () => {
        expect(await readProvision(ctxOf(B), 'version-a', connectionA)).toBeNull();
        expect(await readProfileAgent(ctxOf(B), 'profile-a', connectionA)).toBeNull();
        expect(await readConnectionEnvironment(ctxOf(B), connectionA)).toBeNull();
        const rows = await runInTenantContext(ctxOf(B), (db) => db.agentProfileProvision.findMany({ where: {} }));
        expect(rows).toEqual([]);
    });

    it("B's run never sees A's workspace connection, or its key", async () => {
        expect(await readWorkspaceConnection(ctxOf(B))).toEqual({ ok: false, reason: 'NO_CONNECTION' });
    });

    it('B cannot write a provision row into A', async () => {
        await expect(
            runInTenantContext(ctxOf(B), (db) =>
                db.agentProfileProvision.create({
                    data: {
                        tenantId: A,
                        profileId: 'profile-x',
                        profileVersionId: 'version-x',
                        connectionId: connectionA,
                        anthropicAgentId: 'agent_x',
                        anthropicAgentVersion: 1,
                        environmentId: 'env_x',
                        systemHash: HASH,
                        toolsHash: HASH,
                    },
                }),
            ),
        ).rejects.toThrow();
        expect(await globalPrisma.agentProfileProvision.count({ where: { tenantId: A } })).toBe(1);
    });

    it('the connection key is ciphertext at rest', async () => {
        const row = await globalPrisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionA }, select: { secretEncrypted: true } });
        expect(row.secretEncrypted).toMatch(/^v[12]:/);
        expect(row.secretEncrypted).not.toContain(KEY_A);
    });

    it('the database refuses a hash that is not hex SHA-256, and an agent version below 1', async () => {
        const bad = (over: Record<string, unknown>) =>
            globalPrisma.agentProfileProvision.create({
                data: {
                    tenantId: A,
                    profileId: 'p',
                    profileVersionId: `v-${randomUUID()}`,
                    connectionId: connectionA,
                    anthropicAgentId: 'agent_y',
                    anthropicAgentVersion: 1,
                    environmentId: 'env_y',
                    systemHash: HASH,
                    toolsHash: HASH,
                    ...over,
                },
            });
        await expect(bad({ systemHash: 'not-a-hash' })).rejects.toThrow();
        await expect(bad({ anthropicAgentVersion: 0 })).rejects.toThrow();
    });
});
