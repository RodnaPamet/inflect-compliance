/**
 * Dev helper — add a User as OWNER of the seeded tenant + ORG_ADMIN
 * of the seeded organization.
 *
 * Mirrors the canonical seed pattern (vanilla PrismaClient, manually
 * computed emailHash, plaintext stored in the @map'd encrypted column).
 * For local-dev convenience only — production tenant onboarding goes
 * through `redeemInvite` or platform-admin `createTenantWithOwner`.
 *
 * Usage:
 *   npx tsx scripts/add-tenant-owner.ts <email> [name]
 *
 * Idempotent: re-running with the same email upgrades existing
 * memberships in place.
 */
process.env.SKIP_ENV_VALIDATION = '1';

import { PrismaClient } from '@prisma/client';
import { hashForLookup } from '@/lib/security/encryption';

async function main(): Promise<void> {
    const email = process.argv[2];
    const name = process.argv[3] ?? email?.split('@')[0] ?? 'Owner';
    if (!email) {
        console.error('Usage: npx tsx scripts/add-tenant-owner.ts <email> [name]');
        process.exit(2);
    }

    const prisma = new PrismaClient();
    try {
        const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!tenant) throw new Error('No tenant found — run `npm run db:reset` first.');

        const org = await prisma.organization.findFirst({
            where: { id: tenant.organizationId ?? undefined },
        });

        const user = await prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            update: { name },
            create: {
                email,
                emailHash: hashForLookup(email),
                name,
                emailVerified: new Date(),
            },
        });

        const membership = await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: {
                tenantId: tenant.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });

        let orgMembershipId: string | null = null;
        if (org) {
            // #4576: never demote an owner (the last-owner trigger would refuse
            // it anyway), and an organization with no owner gets this person
            // as its owner rather than another admin.
            const hasOwner =
                (await prisma.orgMembership.count({ where: { organizationId: org.id, role: 'ORG_OWNER' } })) > 0;
            const current = await prisma.orgMembership.findUnique({
                where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
                select: { role: true },
            });
            const role = current?.role === 'ORG_OWNER' || !hasOwner ? 'ORG_OWNER' : 'ORG_ADMIN';
            const om = await prisma.orgMembership.upsert({
                where: {
                    organizationId_userId: {
                        organizationId: org.id,
                        userId: user.id,
                    },
                },
                update: { role },
                create: {
                    organizationId: org.id,
                    userId: user.id,
                    role,
                },
            });
            orgMembershipId = om.id;
        }

        console.log(`\n✅ ${email} provisioned`);
        console.log(`   user.id            = ${user.id}`);
        console.log(`   tenant             = ${tenant.slug} (${tenant.id})`);
        console.log(`   tenantMembership   = ${membership.id} role=OWNER`);
        if (org) {
            console.log(`   organization       = ${org.slug} (${org.id})`);
            console.log(`   orgMembership      = ${orgMembershipId} role=ORG_ADMIN`);
        } else {
            console.log(`   organization       = (none — tenant not linked to an org)`);
        }
        console.log('');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('add-tenant-owner.fatal', err);
    process.exit(1);
});
