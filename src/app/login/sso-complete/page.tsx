import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { ssoWorkspaceParam } from '@/lib/auth/sso-session';
import { SsoComplete } from './SsoComplete';

export const dynamic = 'force-dynamic';

/**
 * Where the SSO callbacks send the browser after the identity provider
 * answers. The hand-off they left is in an HttpOnly cookie; the client half
 * asks NextAuth to redeem it, which opens the session, and then goes on to
 * `next`. `next` is sanitised again here: anyone can type this URL.
 *
 * `sso` names the workspace whose identity provider answered, so a failed
 * completion can go back to that workspace's sign-in. It only fills in the
 * sign-in form, which anybody can do with `/login?sso=`; it is still held to
 * a slug's shape.
 */
export default async function SsoCompletePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { next, sso } = await searchParams;
    return (
        <SsoComplete
            next={typeof next === 'string' ? sanitizeRedirectPath(next) : '/tenants'}
            workspace={ssoWorkspaceParam(sso)}
        />
    );
}
