/**
 * Epic 1, PR 2 — Bootstrap OWNER role for existing tenants.
 *
 * One-time script. For every tenant that currently has zero ACTIVE
 * OWNER memberships, promotes the oldest ACTIVE ADMIN to OWNER and
 * writes a hash-chained audit entry. Idempotent: tenants that
 * already have an OWNER are skipped.
 *
 * ## Deployment order
 *   1. Apply `prisma migrate deploy` (lands the last-OWNER trigger).
 *   2. Run `npm run db:bootstrap-owners` (this script) once on prod.
 *
 * ## Why a script and not raw SQL?
 *   The audit trail is hash-chained via `appendAuditEntry` in the
 *   application layer. A raw SQL UPDATE would skip the advisory-lock
 *   chain and break integrity checks. The script imports the real
 *   `appendAuditEntry` so every promotion lands a valid, linked
 *   audit row.
 *
 * ## Usage
 *   npm run db:bootstrap-owners          # dry-run (no writes)
 *   npm run db:bootstrap-owners --execute # write
 */

process.env.SKIP_ENV_VALIDATION = '1';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { appendAuditEntry } from '../src/lib/audit/audit-writer';

interface TenantRow {
    id: string;
    slug: string;
}

interface MembershipRow {
    id: string;
    userId: string;
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute');
    const mode = execute ? 'EXECUTE' : 'DRY RUN';

    console.log(`\n── Epic 1 PR 2 — bootstrap-tenant-owners — ${mode} ──\n`);
    if (!execute) {
        console.log('  No writes performed. Rerun with --execute to persist.\n');
    }

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
    let promoted = 0;
    let skipped = 0;
    let errors = 0;

    try {
        // 1. Find all tenants.
        const tenants: TenantRow[] = await prisma.$queryRawUnsafe<TenantRow[]>(
            `SELECT id, slug FROM "Tenant" ORDER BY "createdAt" ASC`,
        );

        console.log(`  Total tenants: ${tenants.length}\n`);

        for (const tenant of tenants) {
            try {
                // 2. Check if this tenant already has an ACTIVE OWNER.
                const existing: Array<{ count: string }> =
                    await prisma.$queryRawUnsafe<Array<{ count: string }>>(
                        `SELECT COUNT(*) AS count
                         FROM "TenantMembership"
                         WHERE "tenantId" = $1
                           AND "role" = 'OWNER'
                           AND "status" = 'ACTIVE'`,
                        tenant.id,
                    );
                const ownerCount = parseInt(existing[0]?.count ?? '0', 10);

                if (ownerCount > 0) {
                    skipped++;
                    console.log(`  [skip]    ${tenant.slug} — already has ${ownerCount} OWNER(s)`);
                    continue;
                }

                // 3. Pick the oldest ACTIVE ADMIN membership.
                const candidates: MembershipRow[] =
                    await prisma.$queryRawUnsafe<MembershipRow[]>(
                        `SELECT id, "userId"
                         FROM "TenantMembership"
                         WHERE "tenantId" = $1
                           AND "role" = 'ADMIN'
                           AND "status" = 'ACTIVE'
                         ORDER BY "createdAt" ASC
                         LIMIT 1`,
                        tenant.id,
                    );

                if (candidates.length === 0) {
                    console.warn(
                        `  [warn]    ${tenant.slug} — no ACTIVE ADMIN found; ` +
                        `cannot bootstrap OWNER. Manual intervention required.`,
                    );
                    skipped++;
                    continue;
                }

                const candidate = candidates[0];

                if (!execute) {
                    promoted++;
                    console.log(
                        `  [dry-run] ${tenant.slug} — would promote membership ${candidate.id} ` +
                        `(userId=${candidate.userId}) to OWNER`,
                    );
                    continue;
                }

                // 4a. Promote the membership.
                const updated = await prisma.$executeRawUnsafe(
                    `UPDATE "TenantMembership"
                     SET "role" = 'OWNER', "updatedAt" = NOW()
                     WHERE id = $1`,
                    candidate.id,
                );
                if (updated === 0) {
                    console.warn(`  [warn]    ${tenant.slug} — UPDATE affected 0 rows (raced?), skipping`);
                    skipped++;
                    continue;
                }

                // 4b. Write hash-chained audit entry. appendAuditEntry opens its
                //     own advisory-locked transaction internally — passing the
                //     singleton prisma client (not a tx-client) is correct here.
                await appendAuditEntry({
                    tenantId: tenant.id,
                    userId: candidate.userId,
                    actorType: 'SYSTEM',
                    entity: 'TenantMembership',
                    entityId: candidate.id,
                    action: 'ROLE_PROMOTED_TO_OWNER',
                    detailsJson: {
                        category: 'membership',
                        reason: 'MIGRATION_BOOTSTRAP_EPIC1_PR2',
                        previousRole: 'ADMIN',
                        newRole: 'OWNER',
                        membershipId: candidate.id,
                        userId: candidate.userId,
                    },
                });

                promoted++;
                console.log(
                    `  [promote] ${tenant.slug} — membership ${candidate.id} ` +
                    `(userId=${candidate.userId}) → OWNER`,
                );
            } catch (err) {
                errors++;
                console.error(
                    `  [error]   ${tenant.slug} — ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        console.log(`\n── Summary ──`);
        console.log(`  promoted:  ${promoted}`);
        console.log(`  skipped:   ${skipped}`);
        console.log(`  errors:    ${errors}`);
        console.log('');

        if (errors > 0) {
            console.error('❌ Completed with errors — check lines above.');
            process.exit(1);
        } else if (!execute) {
            console.log('✅ Dry run complete. Rerun with --execute to persist.');
        } else {
            console.log('✅ Bootstrap complete.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('bootstrap-tenant-owners.fatal', err);
    process.exit(2);
});
