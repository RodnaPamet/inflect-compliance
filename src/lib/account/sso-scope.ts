/**
 * What an SSO-scoped session may do to the ACCOUNT, as opposed to a workspace.
 *
 * A session opened through a workspace's single sign-on is vouched for by that
 * workspace's identity provider, and the provider is configured by that
 * workspace's administrator: it vouches for the person in that workspace and
 * nowhere else (`src/lib/auth/sso-session.ts`). The workspace gates already
 * refuse every other workspace to such a session. The account routes are not
 * workspace-scoped, so they ask here:
 *
 *   - An account-wide write (display name, avatar) is seen in every workspace
 *     and organisation the account belongs to. An SSO-scoped session may make
 *     it only while the account belongs to no other workspace and no
 *     organisation, so nothing outside its own workspace sees the change.
 *   - Reading a colleague's avatar is scoped to the session's own workspace,
 *     and a workspace the Entra gate refused this session counts for nothing.
 */
import prisma from '@/lib/prisma';
import { forbidden } from '@/lib/errors/types';

export interface AccountSessionScope {
    userId: string;
    ssoTenantId?: string | null;
    entraGateDeniedTenantIds?: readonly string[] | null;
}

export const SSO_SCOPED_ACCOUNT_WRITE_REFUSAL =
    'This change applies to your account in every workspace. Sign in with your password or a Google or Microsoft account to make it, because this session was opened by one workspace’s single sign-on.';

/** Refuse an account-wide write from an SSO-scoped session that reaches beyond its workspace. */
export async function assertAccountWideWriteInScope(scope: AccountSessionScope): Promise<void> {
    if (scope.ssoTenantId == null) return;
    const [otherWorkspaces, organisations] = await Promise.all([
        prisma.tenantMembership.count({
            where: { userId: scope.userId, tenantId: { not: scope.ssoTenantId } },
        }),
        prisma.orgMembership.count({ where: { userId: scope.userId } }),
    ]);
    if (otherWorkspaces > 0 || organisations > 0) {
        throw forbidden(SSO_SCOPED_ACCOUNT_WRITE_REFUSAL);
    }
}
