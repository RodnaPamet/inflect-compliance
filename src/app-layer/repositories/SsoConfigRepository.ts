import prisma from '@/lib/prisma';
import type { TenantIdentityProvider, Prisma } from '@prisma/client';

/**
 * Repository for TenantIdentityProvider CRUD.
 * All methods enforce tenant-scoping.
 */

export async function findByTenantId(tenantId: string): Promise<TenantIdentityProvider[]> {
    return prisma.tenantIdentityProvider.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
    });
}

export async function findById(tenantId: string, id: string): Promise<TenantIdentityProvider | null> {
    return prisma.tenantIdentityProvider.findFirst({
        where: { id, tenantId },
    });
}

export async function findEnabledByTenantId(tenantId: string): Promise<TenantIdentityProvider[]> {
    return prisma.tenantIdentityProvider.findMany({
        where: { tenantId, isEnabled: true },
        orderBy: { createdAt: 'asc' },
    });
}

/**
 * Find an IdP by email domain. Used for domain-based SSO discovery.
 * Returns the first enabled provider that claims this domain.
 */
export async function findByDomain(domain: string): Promise<TenantIdentityProvider | null> {
    const lowerDomain = domain.toLowerCase();
    return prisma.tenantIdentityProvider.findFirst({
        where: {
            isEnabled: true,
            emailDomains: { has: lowerDomain },
        },
    });
}

export async function upsert(
    tenantId: string,
    data: {
        id?: string;
        name: string;
        type: 'SAML' | 'OIDC';
        isEnabled?: boolean;
        isEnforced?: boolean;
        emailDomains?: string[];
        configJson?: Prisma.InputJsonValue;
    }
): Promise<TenantIdentityProvider> {
    const { id, ...fields } = data;

    if (id) {
        // Update existing — tenant-scoped guard
        return prisma.tenantIdentityProvider.update({
            where: { id },
            data: {
                ...fields,
                configJson: fields.configJson ?? undefined,
            },
        });
    }

    return prisma.tenantIdentityProvider.create({
        data: {
            tenantId,
            name: fields.name,
            type: fields.type,
            isEnabled: fields.isEnabled ?? false,
            isEnforced: fields.isEnforced ?? false,
            emailDomains: fields.emailDomains ?? [],
            configJson: fields.configJson ?? {},
        },
    });
}

/**
 * Update a provider and delete every identity link to it, in one
 * transaction: a link records that the OLD identity provider vouched for a
 * subject, which says nothing about the new one. Each member's next sign-in
 * links them again, by email.
 */
export async function updateAndRemoveLinks(
    tenantId: string,
    id: string,
    fields: {
        name: string;
        type: 'SAML' | 'OIDC';
        isEnabled?: boolean;
        isEnforced?: boolean;
        emailDomains?: string[];
        configJson: Prisma.InputJsonValue;
    },
): Promise<{ provider: TenantIdentityProvider; linksRemoved: number }> {
    return prisma.$transaction(async (tx) => {
        const { count } = await tx.userIdentityLink.deleteMany({ where: { tenantId, providerId: id } });
        const provider = await tx.tenantIdentityProvider.update({ where: { id }, data: fields });
        return { provider, linksRemoved: count };
    });
}

export async function remove(tenantId: string, id: string): Promise<void> {
    // Ensure the provider belongs to this tenant before deleting
    await prisma.tenantIdentityProvider.deleteMany({
        where: { id, tenantId },
    });
}

export async function setEnabled(tenantId: string, id: string, isEnabled: boolean): Promise<TenantIdentityProvider> {
    return prisma.tenantIdentityProvider.updateMany({
        where: { id, tenantId },
        data: { isEnabled },
    }).then(() => prisma.tenantIdentityProvider.findFirstOrThrow({ where: { id, tenantId } }));
}

export async function setEnforced(tenantId: string, id: string, isEnforced: boolean): Promise<TenantIdentityProvider> {
    return prisma.tenantIdentityProvider.updateMany({
        where: { id, tenantId },
        data: { isEnforced },
    }).then(() => prisma.tenantIdentityProvider.findFirstOrThrow({ where: { id, tenantId } }));
}
