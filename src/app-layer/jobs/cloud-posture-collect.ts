/**
 * cloud-posture collector jobs (PR-3).
 *
 * Thin delegators to the tenant-scoped `runCloudPostureCollection` usecase —
 * each supplies its cloud's provider + control map. Mirrors
 * `aws-posture-collect.ts` (tenant-scoped, enqueued per-connection).
 */
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import { AZURE_POSTURE_CONTROL_MAP } from '@/data/integrations/azure-posture-control-map';
import { GCP_POSTURE_CONTROL_MAP } from '@/data/integrations/gcp-posture-control-map';

interface CollectPayload {
    tenantId: string;
    connectionId: string;
}

export async function runAzurePostureCollectJob(payload: CollectPayload) {
    if (!payload.tenantId || !payload.connectionId) throw new Error('azure-posture-collect requires tenantId + connectionId');
    const r = await runCloudPostureCollection({
        cloud: 'azure-posture',
        tenantId: payload.tenantId,
        connectionId: payload.connectionId,
        provider: new AzurePostureProvider(),
        controlMap: AZURE_POSTURE_CONTROL_MAP,
    });
    // Whole result — a field-by-field shim drops errorMessage/noRetry silently.
    return r;
}

export async function runGcpPostureCollectJob(payload: CollectPayload) {
    if (!payload.tenantId || !payload.connectionId) throw new Error('gcp-posture-collect requires tenantId + connectionId');
    const r = await runCloudPostureCollection({
        cloud: 'gcp-posture',
        tenantId: payload.tenantId,
        connectionId: payload.connectionId,
        provider: new GcpPostureProvider(),
        controlMap: GCP_POSTURE_CONTROL_MAP,
    });
    // Whole result — a field-by-field shim drops errorMessage/noRetry silently.
    return r;
}
