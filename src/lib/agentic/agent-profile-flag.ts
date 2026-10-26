/**
 * The deployment gate on every agent profile route (Step 1a, #4143).
 *
 * With `AGENT_PROFILES` off a profile route answers 404 BEFORE its permission
 * check, so a deployment without the surface answers every caller alike and
 * says nothing about who may act there. It wraps the route's
 * `requirePermission(...)`, which stays literal in the route file, and sits
 * inside `withApiErrorHandling`, which turns the thrown 404 into the response.
 *
 * Since Step 1H (#4145) the surface can also be opened to named tenants only,
 * through `AGENT_PROFILES_TENANTS`. The gate reads the tenant from the route's
 * own `tenantSlug` segment, because it runs before any context is built: a
 * route for a tenant the list does not name answers the same 404.
 *
 * Server-only: it reads the environment.
 */
import { env } from '@/env';
import { notFound } from '@/lib/errors/types';

import { agentProfilesEnabledFor } from './agent-profile';

/** The `tenantSlug` segment from a route handler's second argument, if it has one. */
async function routeTenantSlug(routeArgs: unknown): Promise<string | null> {
    const params = await (routeArgs as { params?: unknown } | undefined)?.params;
    const slug = (params as { tenantSlug?: unknown } | null | undefined)?.tenantSlug;
    return typeof slug === 'string' ? slug : null;
}

export function whenAgentProfilesEnabled<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        const slug = await routeTenantSlug(args[1]);
        if (!agentProfilesEnabledFor(env.AGENT_PROFILES, env.AGENT_PROFILES_TENANTS, slug)) throw notFound('Not found.');
        return handler(...args);
    };
}
