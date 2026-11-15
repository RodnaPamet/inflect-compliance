import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async () => {
    const session = await auth();
    if (!session?.user) {
        return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    // The tenant reported is one this SESSION may reach (#5303): a session
    // opened by a workspace's single sign-on is scoped to that workspace
    // (`src/lib/auth/sso-session.ts`), a workspace the Entra group gate
    // refused at sign-in stays refused for the session
    // (`src/lib/auth/entra-gate-scope.ts`), and a soft-deleted workspace is
    // nobody's — the rules the membership claims and the DB-backed
    // workspace gates apply.
    const ssoTenantId = session.user.ssoTenantId;
    const entraDenied = session.user.entraGateDeniedTenantIds ?? [];

    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
            id: true,
            email: true,
            name: true,
            tenantMemberships: {
                where: {
                    status: 'ACTIVE',
                    tenant: { deletedAt: null },
                    ...(ssoTenantId != null ? { tenantId: ssoTenantId } : {}),
                    ...(entraDenied.length > 0 ? { NOT: { tenantId: { in: entraDenied } } } : {}),
                },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: {
                    role: true,
                    tenant: { select: { id: true, name: true, slug: true } },
                },
            },
        },
    });

    const membership = user?.tenantMemberships[0];

    return jsonResponse({
        user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
            role: membership?.role ?? 'READER',
        },
        tenant: membership?.tenant ?? null,
    });
});
