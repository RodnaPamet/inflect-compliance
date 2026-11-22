/**
 * Staging Seed — Deterministic, idempotent seed for staging environments.
 *
 * Runs the base seed (prisma/seed.ts) first, then adds staging-specific
 * demo data: tasks, evidence placeholders, an audit cycle, and a few
 * control → requirement links.
 *
 * Usage:
 *   npx tsx scripts/seed-staging.ts
 *   npm run seed:staging
 *
 * Idempotent: safe to run multiple times without duplicating data.
 *
 * Rewritten for #5134. It could not run at all: `hashForLookup` was never
 * imported, the client had no driver adapter (Prisma 7 throws on the first
 * query), the base seed was started as a side-effect `require` and then
 * waited on with a three-second sleep, and the rows it wrote used field and
 * enum names the schema no longer has (`priority: 'HIGH'`, `Evidence.name`,
 * `AuditCycle.title`, a link without its `tenantId`).
 *
 * The encrypted free-text columns (`Task.description`, `Evidence.description`)
 * are left empty on purpose: this client writes without the encryption
 * extension, and demo rows need only their titles.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashForLookup } from '../src/lib/security/encryption';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

// ── Config (override via env vars) ──
const STAGING_TENANT_SLUG = process.env.STAGING_TENANT_SLUG || 'acme-corp';
const STAGING_ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL || 'admin@acme.com';

/** Runs prisma/seed.ts to completion and fails when it fails. */
function runBaseSeed(): void {
    const seed = path.resolve(__dirname, '../prisma/seed.ts');
    const run = spawnSync('npx', ['tsx', seed], { stdio: 'inherit', env: process.env });
    if (run.status !== 0) {
        throw new Error(`base seed exited with ${run.status ?? run.signal}`);
    }
}

const DEMO_TASKS = [
    { title: 'Complete annual risk assessment', priority: 'P1', status: 'OPEN' },
    { title: 'Update access control policy', priority: 'P2', status: 'IN_PROGRESS' },
    { title: 'Schedule penetration test', priority: 'P1', status: 'OPEN' },
    { title: 'Employee security awareness training', priority: 'P2', status: 'RESOLVED' },
    { title: 'Review vendor SLAs', priority: 'P3', status: 'OPEN' },
] as const;

const DEMO_EVIDENCE = [
    { title: 'Access Review Log Q1', status: 'APPROVED' },
    { title: 'Penetration Test Report', status: 'APPROVED' },
    { title: 'Security Training Completion Certificate', status: 'APPROVED' },
    { title: 'Firewall Configuration Snapshot', status: 'DRAFT' },
] as const;

const AUDIT_CYCLE_NAME = 'ISO 27001 Annual Audit';

async function seedStaging(): Promise<void> {
    console.log('── Staging Seed — Inflect Compliance ──');
    console.log(`  Tenant: ${STAGING_TENANT_SLUG}`);
    console.log(`  Admin:  ${STAGING_ADMIN_EMAIL}\n`);

    console.log('── Step 1: base seed ──');
    runBaseSeed();

    console.log('\n── Step 2: staging demo data ──');
    const tenant = await prisma.tenant.findUnique({ where: { slug: STAGING_TENANT_SLUG } });
    if (!tenant) throw new Error(`Tenant "${STAGING_TENANT_SLUG}" not found. Did the base seed run?`);
    const admin = await prisma.user.findUnique({ where: { emailHash: hashForLookup(STAGING_ADMIN_EMAIL) } });
    if (!admin) throw new Error(`Admin user "${STAGING_ADMIN_EMAIL}" not found.`);

    for (const t of DEMO_TASKS) {
        const existing = await prisma.task.findFirst({ where: { tenantId: tenant.id, title: t.title } });
        if (!existing) {
            await prisma.task.create({
                data: {
                    tenantId: tenant.id,
                    title: t.title,
                    priority: t.priority,
                    status: t.status,
                    createdByUserId: admin.id,
                    assigneeUserId: admin.id,
                },
            });
        }
    }
    console.log(`✅ ${DEMO_TASKS.length} demo tasks`);

    for (const e of DEMO_EVIDENCE) {
        const existing = await prisma.evidence.findFirst({ where: { tenantId: tenant.id, title: e.title } });
        if (!existing) {
            await prisma.evidence.create({
                data: { tenantId: tenant.id, title: e.title, type: 'TEXT', status: e.status, ownerUserId: admin.id },
            });
        }
    }
    console.log(`✅ ${DEMO_EVIDENCE.length} evidence placeholders`);

    const cycle = await prisma.auditCycle.findFirst({ where: { tenantId: tenant.id, name: AUDIT_CYCLE_NAME } });
    if (!cycle) {
        await prisma.auditCycle.create({
            data: {
                tenantId: tenant.id,
                frameworkKey: 'ISO27001',
                frameworkVersion: '2022',
                name: AUDIT_CYCLE_NAME,
                createdByUserId: admin.id,
            },
        });
    }
    console.log('✅ demo audit cycle');

    const controls = await prisma.control.findMany({ where: { tenantId: tenant.id }, take: 4, orderBy: { id: 'asc' } });
    const iso27001 = await prisma.framework.findFirst({ where: { key: 'ISO27001' } });
    if (iso27001 && controls.length > 0) {
        const requirements = await prisma.frameworkRequirement.findMany({
            where: { frameworkId: iso27001.id, deprecatedAt: null },
            take: 4,
            orderBy: { sortOrder: 'asc' },
        });
        const pairs = Math.min(controls.length, requirements.length);
        for (let i = 0; i < pairs; i++) {
            await prisma.controlRequirementLink.upsert({
                where: { controlId_requirementId: { controlId: controls[i].id, requirementId: requirements[i].id } },
                create: { tenantId: tenant.id, controlId: controls[i].id, requirementId: requirements[i].id },
                update: {},
            });
        }
        console.log(`✅ ${pairs} control → requirement links`);
    }

    const counts = {
        controls: await prisma.control.count({ where: { tenantId: tenant.id } }),
        tasks: await prisma.task.count({ where: { tenantId: tenant.id } }),
        evidence: await prisma.evidence.count({ where: { tenantId: tenant.id } }),
        auditCycles: await prisma.auditCycle.count({ where: { tenantId: tenant.id } }),
    };
    console.log('\n── Staging seed complete ──');
    console.log(JSON.stringify(counts));
    console.log(`Login: ${STAGING_ADMIN_EMAIL} (password set by the base seed's SEED_PASSWORD)`);
}

seedStaging()
    .catch((err) => {
        console.error('❌ Staging seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
