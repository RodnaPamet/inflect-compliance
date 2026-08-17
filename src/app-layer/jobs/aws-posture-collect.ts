/**
 * aws-posture-collect job — run one tenant's AWS posture benchmark and record
 * the IntegrationExecution + auto-collected Evidence. Thin delegator to the
 * `runAwsPostureCollection` usecase; tenantId + connectionId travel in the
 * payload and the usecase builds its own tenant-scoped context (runInTenantContext).
 */
import { runAwsPostureCollection, type AwsPostureCollectResult } from '@/app-layer/usecases/aws-posture';
import type { AwsPostureCollectPayload } from './types';

export async function runAwsPostureCollectJob(
    payload: AwsPostureCollectPayload,
): Promise<AwsPostureCollectResult> {
    if (!payload.tenantId || !payload.connectionId) {
        throw new Error('aws-posture-collect requires tenantId + connectionId');
    }
    // Whole result — a field-by-field shim drops errorMessage/noRetry silently.
    return runAwsPostureCollection({ tenantId: payload.tenantId, connectionId: payload.connectionId });
}
