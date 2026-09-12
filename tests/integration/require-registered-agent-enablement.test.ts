/**
 * #2443/#2444 — the guarded enablement flow for `requireRegisteredAgent`.
 *
 * ── WHAT MAKES THIS SETTING DIFFERENT ───────────────────────────────
 *
 * It is the switch that decides whether the register, the tool allowlist, both
 * autonomy terms, the policy card, the circuit breaker and the agent arm of the
 * kill switch mean anything at all. The introducing migration set it to FALSE
 * for every pre-existing tenant — deliberately, because the second precondition
 * was unmet: the create-key form sent no `agentId`, so every UI-minted
 * credential stood at `no_binding`. Enabling without fixing that stops every
 * agent using a UI-minted key, at once, at the tool boundary.
 *
 * So the pre-flight is not a nicety. It is the difference between a change an
 * operator can make deliberately and one they can only make by accident.
 *
 * ── THE LIST, NOT THE COUNT ─────────────────────────────────────────
 *
 * Every assertion below compares the exact SET of credential ids. A count is
 * satisfiable by the wrong rows — and the wrong rows here means telling somebody
 * "3 credentials will stop working" while naming three that will not, which is
 * worse than saying nothing, because they will go and check those three.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    previewAgentEnforcement,
    updateTenantSecurityConfig,
} from '@/app-layer/usecases/tenant-security-settings';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TENANT = 'rra-tenant';
const SLUG = 'rra-tenant';
const EMAIL = 'rra-admin@example.test';

let userId = '';
let agentId = '';
const keys: Record<string, string> = {};

/** Full authority: settings AND the agent register. */
function fullCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SLUG, userId });
}

/**
 * `admin.manage` WITHOUT `admin.agent_registry`.
 *
 * The combination #2444 is about: a legitimate settings administrator who
 * cannot read the register whose enforcement they would be switching on.
 */
function settingsOnlyCtx() {
    const ctx = fullCtx();
    return {
        ...ctx,
        appPermissions: {
            ...ctx.appPermissions,
            admin: { ...ctx.appPermissions.admin, agent_registry: false },
        },
    };
}

async function mintKey(
    label: string,
    overrides: Record<string, unknown> = {},
): Promise<string> {
    const row = await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: label,
            keyPrefix: `rra_${label}`,
            keyHash: `hash-${label}`,
            createdById: userId,
            ...overrides,
        },
    });
    keys[label] = row.id;
    return row.id;
}

/**
 * Teardown, in FK order, and run from `beforeAll` as well as `afterAll`.
 *
 * `AuditLog` is the one that bites: this suite exists to prove both directions
 * of the setting are audited, so it necessarily leaves audit rows pointing at
 * the tenant — and `AuditLog_tenantId_fkey` then refuses the tenant delete. A
 * suite that asserts an audit trail has to clean up the trail it asserted.
 *
 * Idempotent because a run that dies mid-flight leaves these behind, and the
 * next run's `tenant.create` then fails on `Tenant_pkey` — a setup error that
 * reports as ten failing assertions about permissions.
 */
async function clearProbeRows() {
    // `resetDatabase` TRUNCATEs its ROOTS — `AuditLog` among them — with
    // CASCADE. Deleting audit rows by hand instead fails on an FK this file has
    // no business knowing about, and the trail is exactly what this suite
    // generates: it asserts BOTH directions of the setting are audited, so it
    // necessarily leaves rows that refuse the tenant delete.
    await resetDatabase(prisma);
    await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
    await clearProbeRows();

    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: SLUG } });
    const user = await prisma.user.create({ data: { email: EMAIL, name: 'rra admin' } });
    userId = user.id;

    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: 'rra host', ownerUserId: userId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name: 'rra agent',
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: userId,
            status: 'ACTIVE',
        },
    });
    agentId = agent.id;

    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);

    // WOULD break: active, no binding.
    await mintKey('unbound-a');
    await mintKey('unbound-b', { expiresAt: future });
    // Would NOT break, one reason each.
    await mintKey('bound', { agentId: agent.id });
    await mintKey('revoked', { revokedAt: past });
    await mintKey('expired', { expiresAt: past });
});

afterAll(clearProbeRows);

describe('the pre-flight names exactly what would break', () => {
    it('returns the ACTIVE UNBOUND credentials, as a set of ids', async () => {
        const preflight = await previewAgentEnforcement(fullCtx());
        expect(preflight.breaking.map((c) => c.id).sort()).toEqual(
            [keys['unbound-a'], keys['unbound-b']].sort(),
        );
    });

    it('the three exclusions are exclusions, not an empty database', async () => {
        // POSITIVE CONTROL. Without this, a pre-flight that returned rows from
        // the wrong tenant — or a fixture that never created the bound, revoked
        // and expired keys at all — would satisfy the assertion above.
        const all = await prisma.tenantApiKey.findMany({
            where: { tenantId: TENANT },
            select: { id: true },
        });
        expect(all).toHaveLength(5);

        const preflight = await previewAgentEnforcement(fullCtx());
        const breaking = new Set(preflight.breaking.map((c) => c.id));
        expect(breaking.has(keys['bound'])).toBe(false);
        expect(breaking.has(keys['revoked'])).toBe(false);
        expect(breaking.has(keys['expired'])).toBe(false);
    });

    it('names each credential, so an operator can act on it', async () => {
        // A list of opaque ids is a count with extra steps.
        const preflight = await previewAgentEnforcement(fullCtx());
        for (const c of preflight.breaking) {
            expect(c.name).toBeTruthy();
            expect(c.keyPrefix).toBeTruthy();
        }
    });

    it('reports an ABSENT settings row as ENFORCING', async () => {
        // The column defaults true and a tenant created after the gate shipped
        // has no row. Reading that as "not enforcing" would tell the one tenant
        // that IS protected that it is not.
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        expect((await previewAgentEnforcement(fullCtx())).enforcing).toBe(true);
    });
});

describe('the gate is stronger for this field, and scoped to it', () => {
    it('refuses the pre-flight without the agent register permission', async () => {
        await expect(previewAgentEnforcement(settingsOnlyCtx())).rejects.toThrow(
            /agent register permission/i,
        );
    });

    it('refuses to WRITE the field without it, on the shared settings path', async () => {
        // The check lives in the usecase precisely so the general settings PUT
        // cannot be used to go around the dedicated route.
        await expect(
            updateTenantSecurityConfig(settingsOnlyCtx(), { requireRegisteredAgent: true }),
        ).rejects.toThrow(/agent register permission/i);
    });

    it('still allows that caller to write the OTHER settings fields', async () => {
        // Paired positive. A gate that refused everything would pass both
        // assertions above and read as working authority while actually being a
        // broken settings page.
        const result = await updateTenantSecurityConfig(settingsOnlyCtx(), {
            maxConcurrentSessions: 7,
        });
        expect(result.maxConcurrentSessions).toBe(7);
    });
});

describe('both directions are audited, on the hash chain', () => {
    async function latestSettingsAudit() {
        return prisma.auditLog.findFirst({
            where: { tenantId: TENANT, action: 'SECURITY_SETTINGS_UPDATED' },
            orderBy: { createdAt: 'desc' },
        });
    }

    it('enabling writes a hash-chained row that names the field', async () => {
        await updateTenantSecurityConfig(fullCtx(), { requireRegisteredAgent: true });
        const row = await latestSettingsAudit();
        expect(row).not.toBeNull();
        expect(row!.details).toContain('requireRegisteredAgent');
        expect(row!.entryHash).not.toBeNull();
    });

    it('DISABLING is audited too — the direction that removes protection', async () => {
        // The direction an incident review actually asks about. Auditing only
        // the enable would leave the removal of enforcement as the one
        // unrecorded transition.
        const before = await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'SECURITY_SETTINGS_UPDATED' },
        });
        await updateTenantSecurityConfig(fullCtx(), { requireRegisteredAgent: false });
        const after = await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'SECURITY_SETTINGS_UPDATED' },
        });
        expect(after).toBe(before + 1);

        const row = await latestSettingsAudit();
        expect(row!.details).toContain('requireRegisteredAgent');
        expect(row!.entryHash).not.toBeNull();
    });

    it('the pre-flight reflects the write that just happened', async () => {
        expect((await previewAgentEnforcement(fullCtx())).enforcing).toBe(false);
        await updateTenantSecurityConfig(fullCtx(), { requireRegisteredAgent: true });
        expect((await previewAgentEnforcement(fullCtx())).enforcing).toBe(true);
    });
});
