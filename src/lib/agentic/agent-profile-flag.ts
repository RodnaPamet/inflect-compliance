/**
 * The deployment gate on every agent profile route (Step 1a, #4143).
 *
 * With `AGENT_PROFILES` off a profile route answers 404 BEFORE its permission
 * check, so a deployment without the surface answers every caller alike and
 * says nothing about who may act there. It wraps the route's
 * `requirePermission(...)`, which stays literal in the route file, and sits
 * inside `withApiErrorHandling`, which turns the thrown 404 into the response.
 *
 * Server-only: it reads the environment.
 */
import { env } from '@/env';
import { notFound } from '@/lib/errors/types';

import { agentProfilesEnabled } from './agent-profile';

export function whenAgentProfilesEnabled<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        if (!agentProfilesEnabled(env.AGENT_PROFILES)) throw notFound('Not found.');
        return handler(...args);
    };
}
