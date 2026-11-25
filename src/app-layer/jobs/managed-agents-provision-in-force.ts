/**
 * `managed-agents-provision-in-force` (#5964, owner decisions 2026-11-25):
 * provision a workspace's agent profile versions in force as Managed Agents.
 *
 * Enqueued, never scheduled, by the two writes that can make the engine
 * usable, each once it has committed: `setManagedAgentsSwitch` turning the
 * switch on (`SWITCH_ON`), and `setAgentDriverSetting` moving the engine to
 * Managed Agents (`ENGINE_CHOSEN`). It acts AS THE OWNER WHOSE WRITE ENQUEUED
 * IT, their membership re-read when it runs, as approval provisions in the
 * approver's name: an owner who has since left, or lost
 * `admin.tenant_lifecycle`, has nothing done in their name, and the job records
 * that on the tenant's SYSTEM user instead. Repeating either write runs it
 * once more, idempotently.
 *
 * Everything else is `provisionProfilesInForce`'s: it never throws and records
 * every outcome.
 */
import { buildTenantSystemJobContext, resolveMemberContext } from '@/app-layer/context-system';
import { logEvent } from '@/app-layer/events/audit';
import { provisionProfilesInForce, type InForceProvisionResult } from '@/app-layer/usecases/managed-agents-switch';
import { runInTenantContext } from '@/lib/db-context';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

import type { ManagedAgentsProvisionInForcePayload } from './types';

const JOB = 'managed-agents-provision-in-force';

export async function runManagedAgentsProvisionInForce(
    payload: ManagedAgentsProvisionInForcePayload,
): Promise<InForceProvisionResult> {
    return runJob(
        JOB,
        async () => {
            const { tenantId, requestedByUserId } = payload;
            const owner = await resolveMemberContext({ tenantId, userId: requestedByUserId, job: JOB });
            if (owner && owner.appPermissions?.admin?.tenant_lifecycle) {
                return provisionProfilesInForce(
                    { ...owner, ...(payload.requestId ? { requestId: payload.requestId } : {}) },
                    payload.trigger,
                );
            }

            const refused: InForceProvisionResult = {
                outcome: 'REQUESTER_NOT_AUTHORISED',
                versions: 0,
                created: 0,
                alreadyProvisioned: 0,
                failed: [],
                truncated: false,
            };
            logger.warn('managed agents: the owner whose write asked can no longer act; nothing provisioned', {
                component: 'agentic',
                tenantId,
                trigger: payload.trigger,
            });
            const system = await buildTenantSystemJobContext({ tenantId, job: JOB, requestId: payload.requestId });
            await runInTenantContext(system, (db) =>
                logEvent(db, system, {
                    action: 'MANAGED_AGENTS_PROFILES_PROVISIONED',
                    entityType: 'Tenant',
                    entityId: tenantId,
                    details: `Managed Agents versions in force (${payload.trigger}): provisioning REQUESTER_NOT_AUTHORISED`,
                    detailsJson: {
                        category: 'access',
                        operation: 'created',
                        summary: `Managed Agents provisioning (${payload.trigger}): REQUESTER_NOT_AUTHORISED`,
                    },
                    metadata: { trigger: payload.trigger, outcome: refused.outcome, requestedByUserId },
                }),
            ).catch(() => undefined);
            return refused;
        },
        { tenantId: payload.tenantId },
    );
}
