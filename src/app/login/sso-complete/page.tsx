import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { SsoComplete } from './SsoComplete';

export const dynamic = 'force-dynamic';

/**
 * Where the SSO callbacks send the browser after the identity provider
 * answers. The hand-off they left is in an HttpOnly cookie; the client half
 * asks NextAuth to redeem it, which opens the session, and then goes on to
 * `next`. `next` is sanitised again here: anyone can type this URL.
 */
export default async function SsoCompletePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { next } = await searchParams;
    return <SsoComplete next={typeof next === 'string' ? sanitizeRedirectPath(next) : '/tenants'} />;
}
