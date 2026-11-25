import { prisma } from '@/lib/prisma';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { integrationRegistry } from '../integrations/registry';
import { PrismaSyncMappingStore } from '../integrations/prisma-sync-store';
import { PrismaLocalStore } from '../integrations/prisma-local-store';
import { openTenantSecret } from '@/lib/security/tenant-sealed';
import { logger } from '@/lib/observability/logger';
import { SyncPullPayload } from './types';

/**
 * Executes a deferred webhook-triggered pull sync in the background.
 *
 * This function resolves the integration connection, instantiates the orchestrator,
 * and calls the underlying `pull` logic for a webhook event.
 */
export async function runSyncPull(payload: SyncPullPayload): Promise<void> {
    const { ctx, mappingKey, remoteData, remoteUpdatedAtIso } = payload;
    const { tenantId, provider } = mappingKey;

    // 1. Find the connection for this provider
    let connection;
    if (mappingKey.connectionId) {
        connection = await prisma.integrationConnection.findUnique({
            where: { id: mappingKey.connectionId },
        });
    } else {
        // Fallback: use first active connection for the provider in this tenant
        connection = await prisma.integrationConnection.findFirst({
            where: { tenantId, provider, isEnabled: true },
        });
    }

    if (!connection) {
        logger.warn('No active connection found for sync-pull sync', {
            component: 'sync-pull',
            tenantId,
            provider,
            connectionId: mappingKey.connectionId,
        });
        return;
    }

    // 2. Decrypt configuration details
    let secrets: Record<string, unknown> = {};
    if (connection.secretEncrypted) {
        try {
            secrets = JSON.parse(await openTenantSecret(connection.tenantId, connection.secretEncrypted));
        } catch (err) {
            logger.error('Failed to decrypt connection secrets for sync-pull sync', {
                component: 'sync-pull',
                tenantId,
                provider,
            });
            throw new Error('Connection secrets could not be decrypted');
        }
    }

    const connectionConfig = {
        ...(connection.configJson as Record<string, unknown>),
        ...secrets,
    };

    // 3. Create orchestrator instance
    const orchestrator = integrationRegistry.createOrchestrator(provider, {
        config: connectionConfig,
        store: new PrismaSyncMappingStore(),
        localStore: new PrismaLocalStore(),
        logger: {
            log: (syncEvent: unknown) => logger.info('Sync event from sync-pull', {
                component: 'sync-pull',
                provider,
                syncEvent,
            }),
        },
    });

    if (!orchestrator) {
        logger.warn('Orchestrator could not be instantiated for provider', {
            component: 'sync-pull',
            provider,
        });
        return;
    }

    // 4. Execute the pull
    const remoteUpdatedAt = new Date(remoteUpdatedAtIso);

    logger.info('Executing deferred sync pull', {
        component: 'sync-pull',
        tenantId,
        provider,
        remoteEntityType: mappingKey.remoteEntityType,
        remoteEntityId: mappingKey.remoteEntityId,
    });

    const result = await orchestrator.pull({
        ctx: ctx as import('@/app-layer/types').RequestContext,
        mappingKey,
        remoteData,
        remoteUpdatedAt,
    });

    logger.info('Deferred sync pull completed', {
        component: 'sync-pull',
        tenantId,
        provider,
        remoteEntityType: mappingKey.remoteEntityType,
        remoteEntityId: mappingKey.remoteEntityId,
        success: result.success,
        action: result.action,
        errorMessage: result.errorMessage,
    });

    if (!result.success) {
        throw new Error(result.errorMessage || 'Sync pull failed');
    }
}
