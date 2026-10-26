/**
 * RQ-2 — daily risk-appetite breach monitor (cross-tenant fan-out).
 *
 * For every tenant with a RiskAppetiteConfig: scan the portfolio,
 * persist new breaches, resolve stale ones. Notifications for new
 * breaches ride the existing pipeline (logged here; wired in follow-up).
 *
 * @module jobs/risk-appetite-jobs
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import type { PermissionSet } from '@/lib/permissions';
import type { Permissions } from '@/lib/tenant-context';
import { initiatorAuthority } from '@/app-layer/context-system';
import {
    checkPortfolioAppetite,
    recordBreaches,
    resolveStaleBreaches,
} from '@/app-layer/usecases/risk-appetite';
import { logger } from '@/lib/observability/logger';
import type { RiskAppetiteMonitorPayload } from './types';

/**
 * Whether a member's resolved authority lets them run the monitor. The monitor
 * reads the risk register (`risks.view`), and the usecases it calls refuse
 * without the coarse read flag (`assertCanRead`). One definition, read when the
 * actor is chosen, so the monitor never acts as a member its own reads refuse.
 */
export function mayMonitorRiskAppetite(authority: {
    permissions: Permissions;
    appPermissions: PermissionSet;
}): boolean {
    return authority.permissions.canRead && authority.appPermissions.risks.view === true;
}

/** Why the monitor did not scan a tenant. Each is logged and returned in the run's result. */
export const RISK_APPETITE_UNROUTABLE = {
    /** The tenant has no ACTIVE OWNER or ADMIN membership at all. */
    NO_ACTIVE_ADMIN: 'NO_ACTIVE_ADMIN',
    /** It has some, but every one's resolved permissions withhold `risks.view`. */
    NO_ADMIN_WITH_RISK_VIEW: 'NO_ADMIN_WITH_RISK_VIEW',
} as const;
export type RiskAppetiteUnroutableReason = keyof typeof RISK_APPETITE_UNROUTABLE;

/**
 * The context the monitor scans a tenant as: its oldest active OWNER/ADMIN whose
 * authority, resolved as a request from them resolves it (`initiatorAuthority`,
 * custom role and coarse flags included, #4388), passes
 * `mayMonitorRiskAppetite`. An admin whose custom role withholds the read is
 * passed over for the next one. Exported for its test.
 */
export async function buildRiskAppetiteContext(
    tenantId: string,
): Promise<{ ok: true; ctx: RequestContext } | { ok: false; reason: RiskAppetiteUnroutableReason }> {
    // Uncapped: one tenant's OWNER/ADMIN memberships. A cap could leave out the
    // member who qualifies and report the tenant as having nobody.
    const admins = await prisma.tenantMembership.findMany({
        where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: {
            userId: true,
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
        orderBy: { createdAt: 'asc' },
    });
    if (admins.length === 0) return { ok: false, reason: RISK_APPETITE_UNROUTABLE.NO_ACTIVE_ADMIN };
    for (const admin of admins) {
        const authority = initiatorAuthority(admin);
        if (!mayMonitorRiskAppetite(authority)) continue;
        return {
            ok: true,
            ctx: {
                requestId: `risk-appetite-${tenantId}`,
                userId: admin.userId,
                tenantId,
                ...authority,
            },
        };
    }
    return { ok: false, reason: RISK_APPETITE_UNROUTABLE.NO_ADMIN_WITH_RISK_VIEW };
}

export async function runRiskAppetiteMonitor(_payload: RiskAppetiteMonitorPayload) {
    const configs = await prisma.riskAppetiteConfig.findMany({ select: { tenantId: true }, take: 5000 });
    let scanned = 0;
    let newBreaches = 0;
    let resolved = 0;
    // A tenant was skipped here in silence when it had no admin to act as.
    const unroutable: Array<{ tenantId: string; reason: RiskAppetiteUnroutableReason }> = [];
    for (const { tenantId } of configs) {
        const actor = await buildRiskAppetiteContext(tenantId);
        if (!actor.ok) {
            unroutable.push({ tenantId, reason: actor.reason });
            logger.warn('risk-appetite-monitor: tenant not scanned', {
                component: 'risk-appetite',
                tenantId,
                reason: actor.reason,
            });
            continue;
        }
        const ctx = actor.ctx;
        try {
            const result = await checkPortfolioAppetite(ctx);
            newBreaches += await recordBreaches(ctx, result.breaches);
            resolved += await resolveStaleBreaches(ctx, result.breaches);
            scanned++;
        } catch (err) {
            logger.warn('risk-appetite-monitor: tenant scan failed', {
                component: 'risk-appetite',
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { tenants: configs.length, scanned, newBreaches, resolved, unroutable };
}
