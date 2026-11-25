/**
 * `managed-agents-provision-on-switch-on` (#5964, owner decision 2026-11-25):
 * provision a workspace's agent profiles after its owner turned the Managed
 * Agents switch on.
 *
 * Enqueued by `setManagedAgentsSwitch` once the switch write has committed,
 * never by a schedule. It acts AS THE OWNER WHO TURNED IT ON, their membership
 * re-read when it runs, as approval provisions in the approver's name: an owner
 * who has since left, or lost `admin.tenant_lifecycle`, has nothing done in
 * their name, and the job records that on the tenant's SYSTEM user instead.
 * Turning the switch off and on again is the way to run it once more.
 *
 * Everything else is `provisionProfilesInForce`'s: it never throws and records
 * every outcome.
 */
import { buildTenantSystemJobContext, resolveMemberContext } from '@/app-layer/context-system';
import { logEvent } from '@/app-layer/events/audit';
import { provisionProfilesInForce, type SwitchOnProvisionResult } from '@/app-layer/usecases/managed-agents-switch';
import { runInTenantContext } from '@/lib/db-context';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

import type { ManagedAgentsProvisionOnSwitchOnPayload } from './types';

const JOB = 'managed-agents-provision-on-switch-on';

export async function runManagedAgentsProvisionOnSwitchOn(
    payload: ManagedAgentsProvisionOnSwitchOnPayload,
): Promise<SwitchOnProvisionResult> {
    return runJob(
        JOB,
        async () => {
            const { tenantId, requestedByUserId } = payload;
            const owner = await resolveMemberContext({ tenantId, userId: requestedByUserId, job: JOB });
            if (owner && owner.appPermissions?.admin?.tenant_lifecycle) {
                return provisionProfilesInForce({ ...owner, ...(payload.requestId ? { requestId: payload.requestId } : {}) });
            }

            const refused: SwitchOnProvisionResult = {
                outcome: 'REQUESTER_NOT_AUTHORISED',
                versions: 0,
                created: 0,
                alreadyProvisioned: 0,
                failed: [],
                truncated: false,
            };
            logger.warn('managed agents switch: the owner who turned it on can no longer act; nothing provisioned', {
                component: 'agentic',
                tenantId,
            });
            const system = await buildTenantSystemJobContext({ tenantId, job: JOB, requestId: payload.requestId });
            await runInTenantContext(system, (db) =>
                logEvent(db, system, {
                    action: 'MANAGED_AGENTS_PROFILES_PROVISIONED',
                    entityType: 'Tenant',
                    entityId: tenantId,
                    details: 'Managed Agents switched on: provisioning REQUESTER_NOT_AUTHORISED',
                    detailsJson: {
                        category: 'access',
                        operation: 'created',
                        summary: 'Managed Agents provisioning on switch-on: REQUESTER_NOT_AUTHORISED',
                    },
                    metadata: { outcome: refused.outcome, requestedByUserId },
                }),
            ).catch(() => undefined);
            return refused;
        },
        { tenantId: payload.tenantId },
    );
}
