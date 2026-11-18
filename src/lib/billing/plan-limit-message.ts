/**
 * The plan-limit refusal's wire format, in one place for both ends.
 *
 * `assertWithinLimit` refuses a create at the cap with a 403 whose message is
 * MACHINE-shaped — `plan_limit_exceeded: FREE plan allows 10 control(s); …` —
 * so a client can recognise it without a new error type on the API contract.
 * Recognising it is the client's job: shown verbatim, the reader got the
 * `plan_limit_exceeded:` prefix and a `control(s)` plural.
 *
 * `formatPlanLimitMessage` is what the server throws and
 * `parsePlanLimitMessage` is what a client reads, so the two cannot drift.
 * `planLimitRefusalOf` reads it straight out of a refused response's body.
 * Client-safe (its one import, `@/lib/api-error`, has none): client
 * components import it.
 */

import { apiErrorMessage } from '@/lib/api-error';

export interface PlanLimitRefusal {
    /** The tenant's effective plan, e.g. `FREE`. */
    plan: string;
    /** The gated resource, e.g. `control`. */
    resource: string;
    /** How many the plan allows. */
    limit: number;
    /** How many the tenant already has. */
    current: number;
}

const PREFIX = 'plan_limit_exceeded:';

/** The message `assertWithinLimit` throws. */
export function formatPlanLimitMessage(r: PlanLimitRefusal): string {
    return (
        `${PREFIX} ${r.plan} plan allows ${r.limit} ${r.resource}(s); ` +
        `tenant currently has ${r.current}. Upgrade to add more.`
    );
}

const PATTERN =
    /^plan_limit_exceeded: (\S+) plan allows (\d+) (\S+)\(s\); tenant currently has (\d+)\./;

/** The refusal's fields, or `null` when `message` is not a plan-limit refusal. */
export function parsePlanLimitMessage(message: string | null | undefined): PlanLimitRefusal | null {
    if (!message || !message.startsWith(PREFIX)) return null;
    const m = PATTERN.exec(message);
    if (!m) return null;
    return { plan: m[1], limit: Number(m[2]), resource: m[3], current: Number(m[4]) };
}

/**
 * The plan-limit refusal in a parsed API error body, or `null` when the body
 * is any other refusal (#5764).
 *
 * The refusal is a 403, the same status as a missing permission, so a page
 * that words every 403 as "only an Owner or Admin can…" tells an Owner the
 * wrong thing. Ask this before treating a 403 as a role refusal.
 */
export function planLimitRefusalOf(body: unknown): PlanLimitRefusal | null {
    return parsePlanLimitMessage(apiErrorMessage(body, ''));
}
