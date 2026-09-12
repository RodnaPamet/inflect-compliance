/**
 * One enabled HRIS connection per tenant — refused at `upsertIntegrationConnection`.
 *
 * ## Why this suite hits a real database
 *
 * The whole of the refusal is a Prisma `where` clause: tenant, HRIS provider,
 * `isEnabled: true`, and `id: { not: self }` on the update path. A mocked
 * `findFirst` returns whatever the double was told to return regardless of that
 * clause, so a unit test can prove the THROW and cannot prove the SELECTION —
 * drop `isEnabled: true` and a mocked suite stays green while the product starts
 * refusing an enable that should be allowed. Every assertion below therefore
 * drives the real query against real rows.
 *
 * ## What two enabled HRIS connections cost
 *
 * The departure reconcile in `usecases/hris-sync` is tenant-scoped, so two
 * enabled HRIS connections alternate nightly: each stamps its own roster and
 * marks everyone with an older stamp TERMINATED — the whole of the other
 * connection's population. TERMINATED is what makes an employee a candidate for
 * a real directory disable on the 05:00 leaver pass.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    upsertIntegrationConnection,
    removeIntegrationConnection,
} from '@/app-layer/usecases/integrations';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `hris-card-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;

/** Wipe the tenant's connections so each test starts from a known cardinality. */
async function clearConnections(): Promise<void> {
    await globalPrisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
}

/** Create one connection directly, bypassing the usecase under test. */
async function seedConnection(opts: {
    provider: string;
    name: string;
    isEnabled: boolean;
}): Promise<string> {
    const row = await globalPrisma.integrationConnection.create({
        data: {
            tenantId: TENANT_ID,
            provider: opts.provider,
            name: opts.name,
            configJson: {},
            isEnabled: opts.isEnabled,
        },
        select: { id: true },
    });
    return row.id;
}

describeFn('one enabled HRIS connection per tenant (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        const email = `${SUITE_TAG}-owner@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: {
                tenantId: TENANT_ID,
                userId: ownerUserId,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            tenantSlug: SUITE_TAG,
            userId: ownerUserId,
        });
    });

    beforeEach(clearConnections);

    afterAll(async () => {
        await clearConnections();
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        if (ownerUserId) await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    // ── The refusal itself ────────────────────────────────────────────

    it('POSITIVE CONTROL: the FIRST enabled HRIS connection is created', async () => {
        // Without this, every "allowed" assertion below could be passing because
        // the whole usecase is broken rather than because the guard let it
        // through. The refusal tests are the other half of the control pair.
        const created = await upsertIntegrationConnection(ctx, {
            provider: 'bamboohr',
            name: 'BambooHR prod',
            configJson: { subdomain: 'acme' },
        });
        expect(created.isEnabled).toBe(true);
        expect(
            await globalPrisma.integrationConnection.count({
                where: { tenantId: TENANT_ID, isEnabled: true },
            }),
        ).toBe(1);
    });

    it('refuses a SECOND enabled HRIS connection and names the one holding the slot', async () => {
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });

        await expect(
            upsertIntegrationConnection(ctx, {
                provider: 'workday',
                name: 'Workday migration',
                configJson: { host: 'acme.workday.com' },
            }),
        ).rejects.toThrow(/BambooHR prod/);

        // The message has to be actionable: WHICH connection holds the slot, and
        // what the operator does about it. A bare "only one allowed" leaves an
        // admin staring at a list of connections with no next step.
        await expect(
            upsertIntegrationConnection(ctx, {
                provider: 'workday',
                name: 'Workday migration',
                configJson: { host: 'acme.workday.com' },
            }),
        ).rejects.toThrow(/bamboohr/);
        await expect(
            upsertIntegrationConnection(ctx, {
                provider: 'workday',
                name: 'Workday migration',
                configJson: { host: 'acme.workday.com' },
            }),
        ).rejects.toThrow(/disable .* first/i);

        // Refused means NOT WRITTEN — the guard runs before the create.
        expect(
            await globalPrisma.integrationConnection.count({
                where: { tenantId: TENANT_ID, provider: 'workday' },
            }),
        ).toBe(0);
    });

    it('refuses ENABLING an existing disabled HRIS connection while another is enabled', async () => {
        // The already-broken-tenant case in miniature. A create-only guard would
        // pass this test's setup straight through.
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });
        const workdayId = await seedConnection({
            provider: 'workday',
            name: 'Workday migration',
            isEnabled: false,
        });

        await expect(
            upsertIntegrationConnection(ctx, {
                id: workdayId,
                provider: 'workday',
                name: 'Workday migration',
                isEnabled: true,
            }),
        ).rejects.toThrow(/BambooHR prod/);

        const after = await globalPrisma.integrationConnection.findUniqueOrThrow({
            where: { id: workdayId },
            select: { isEnabled: true },
        });
        expect(after.isEnabled).toBe(false);
    });

    it('refuses an update that OMITS isEnabled, because that update re-enables', async () => {
        // `isEnabled: input.isEnabled ?? true` — a rename with no isEnabled in
        // the body turns a disabled connection back on. It is an enable, and the
        // guard measures the same expression the write uses.
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });
        const workdayId = await seedConnection({
            provider: 'workday',
            name: 'Workday migration',
            isEnabled: false,
        });

        await expect(
            upsertIntegrationConnection(ctx, {
                id: workdayId,
                provider: 'workday',
                name: 'Workday migration (renamed)',
            }),
        ).rejects.toThrow(/BambooHR prod/);
    });

    it('reads the provider off the STORED row, not the request body', async () => {
        // The update never writes `provider`, so the row stays HRIS whatever the
        // caller claims. Taking the guard's provider from `input.provider` would
        // make `provider: 'github'` a bypass.
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });
        const workdayId = await seedConnection({
            provider: 'workday',
            name: 'Workday migration',
            isEnabled: false,
        });

        await expect(
            upsertIntegrationConnection(ctx, {
                id: workdayId,
                provider: 'github',
                name: 'Workday migration',
                isEnabled: true,
            }),
        ).rejects.toThrow(/BambooHR prod/);
    });

    // ── What the refusal must NOT reach ───────────────────────────────

    it('leaves a NON-HRIS second connection alone', async () => {
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });

        const created = await upsertIntegrationConnection(ctx, {
            provider: 'github',
            name: 'GitHub org',
            configJson: { owner: 'acme', repo: 'infra' },
        });
        expect(created.isEnabled).toBe(true);

        // And a non-HRIS connection is not blocked by ANOTHER non-HRIS one
        // either — the guard keys on the HRIS provider set, not on "two of
        // anything".
        const second = await upsertIntegrationConnection(ctx, {
            provider: 'servicenow',
            name: 'ServiceNow prod',
            configJson: { instance: 'acme.service-now.com' },
        });
        expect(second.isEnabled).toBe(true);
    });

    it('allows creating a second HRIS connection DISABLED', async () => {
        // Staging the migration target is legitimate: the row exists, carries
        // its config, and ingests nothing until the operator switches over.
        await seedConnection({ provider: 'bamboohr', name: 'BambooHR prod', isEnabled: true });

        const created = await upsertIntegrationConnection(ctx, {
            provider: 'workday',
            name: 'Workday migration',
            configJson: { host: 'acme.workday.com' },
            isEnabled: false,
        });
        expect(created.isEnabled).toBe(false);
    });

    it('allows re-saving the connection that already holds the slot', async () => {
        // `id: { not: self }`. Without it the only enabled HRIS connection in a
        // tenant could never be edited again.
        const bambooId = await seedConnection({
            provider: 'bamboohr',
            name: 'BambooHR prod',
            isEnabled: true,
        });

        const updated = await upsertIntegrationConnection(ctx, {
            id: bambooId,
            provider: 'bamboohr',
            name: 'BambooHR production',
            isEnabled: true,
        });
        expect(updated.name).toBe('BambooHR production');
        expect(updated.isEnabled).toBe(true);
    });

    it('never refuses a write that DISABLES — the operator can always step back', async () => {
        // Two enabled HRIS connections, the already-broken state. Disabling must
        // work, or the tenant is wedged in exactly the configuration that
        // destroys its roster nightly.
        const bambooId = await seedConnection({
            provider: 'bamboohr',
            name: 'BambooHR prod',
            isEnabled: true,
        });
        await seedConnection({ provider: 'workday', name: 'Workday migration', isEnabled: true });

        const disabled = await upsertIntegrationConnection(ctx, {
            id: bambooId,
            provider: 'bamboohr',
            name: 'BambooHR prod',
            isEnabled: false,
        });
        expect(disabled.isEnabled).toBe(false);
    });

    it('removeIntegrationConnection is not gated, so it is the way out of a two-enabled tenant', async () => {
        const bambooId = await seedConnection({
            provider: 'bamboohr',
            name: 'BambooHR prod',
            isEnabled: true,
        });
        const workdayId = await seedConnection({
            provider: 'workday',
            name: 'Workday migration',
            isEnabled: true,
        });

        // Step 1 — the admin UI's Disable button on the outgoing vendor.
        await removeIntegrationConnection(ctx, bambooId);
        // Step 2 — the incoming vendor is now editable again.
        const updated = await upsertIntegrationConnection(ctx, {
            id: workdayId,
            provider: 'workday',
            name: 'Workday production',
            isEnabled: true,
        });
        expect(updated.name).toBe('Workday production');
        expect(
            await globalPrisma.integrationConnection.count({
                where: { tenantId: TENANT_ID, isEnabled: true },
            }),
        ).toBe(1);
    });

    // ── The full BambooHR → Workday migration, end to end ─────────────

    it('supports the migration: stage disabled, disable the old, enable the new', async () => {
        await upsertIntegrationConnection(ctx, {
            provider: 'bamboohr',
            name: 'BambooHR prod',
            configJson: { subdomain: 'acme' },
        });
        const staged = await upsertIntegrationConnection(ctx, {
            provider: 'workday',
            name: 'Workday migration',
            configJson: { host: 'acme.workday.com' },
            isEnabled: false,
        });

        // Cutover, in the only order the guard permits.
        const bamboo = await globalPrisma.integrationConnection.findFirstOrThrow({
            where: { tenantId: TENANT_ID, provider: 'bamboohr' },
            select: { id: true },
        });
        await removeIntegrationConnection(ctx, bamboo.id);
        const live = await upsertIntegrationConnection(ctx, {
            id: staged.id,
            provider: 'workday',
            name: 'Workday production',
            isEnabled: true,
        });

        expect(live.isEnabled).toBe(true);
        // Exactly one enabled HRIS connection at every point the dispatcher
        // could have read this tenant.
        const enabledHris = await globalPrisma.integrationConnection.findMany({
            where: { tenantId: TENANT_ID, provider: { in: ['bamboohr', 'workday'] }, isEnabled: true },
            select: { provider: true },
        });
        expect(enabledHris).toEqual([{ provider: 'workday' }]);
    });
});
