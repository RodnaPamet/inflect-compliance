/**
 * Bus ↔ BullMQ wiring.
 *
 * Call `installAutomationBusDispatcher()` once at process startup
 * (web server boot, worker boot) to swap the bus's default no-op
 * dispatcher for one that enqueues an `automation-event-dispatch`
 * job per emitted event.
 *
 * Deliberately kept out of `automation-bus.ts` so that file has no
 * dependency on the BullMQ queue — the bus itself is Edge-safe; the
 * queue isn't. This module is only imported from Node-side bootstrap
 * paths.
 *
 * Idempotent by design: repeated calls just overwrite the dispatcher
 * hook, which is safe because the singleton bus has no in-flight
 * dispatcher state.
 */

import { logger } from '@/lib/observability/logger';
import { enqueue } from '../jobs/queue';
import type { AutomationEventDispatchPayload } from '../jobs/types';
import { getAutomationBus } from './automation-bus';
import type { AutomationDispatcher } from './automation-bus';
import type { AutomationDomainEvent } from './event-contracts';

/**
 * Serialize a `AutomationDomainEvent` into a BullMQ-safe JSON payload.
 * The only lossy field is `emittedAt` (Date → ISO string), which the
 * worker rehydrates via `rehydrateEvent()`.
 */
export function toDispatchPayload(
    event: AutomationDomainEvent
): AutomationEventDispatchPayload {
    return {
        tenantId: event.tenantId,
        event: {
            event: event.event,
            tenantId: event.tenantId,
            entityType: event.entityType,
            entityId: event.entityId,
            actorUserId: event.actorUserId,
            ...(event.actorApiKeyId ? { actorApiKeyId: event.actorApiKeyId } : {}),
            emittedAt: event.emittedAt.toISOString(),
            stableKey: event.stableKey,
            data: event.data as Record<string, unknown>,
        },
    };
}

/**
 * The BullMQ-backed dispatcher. Pure function; exported so it can be
 * composed (e.g. by an in-memory test harness that wants to exercise
 * the same serialization path without Redis).
 */
export const bullmqAutomationDispatcher: AutomationDispatcher = async (
    event
) => {
    try {
        await enqueue('automation-event-dispatch', toDispatchPayload(event));
    } catch (err) {
        // The bus already swallows dispatcher errors (see
        // automation-bus.ts) — logging here gives us a second
        // breadcrumb that the queue enqueue specifically failed.
        logger.error('automation-bus.enqueue_failed', {
            component: 'bus-bootstrap',
            event: event.event,
            tenantId: event.tenantId,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        throw err;
    }
};

let installed = false;

/**
 * Wire the bus to enqueue one `automation-event-dispatch` job per
 * emission. Safe to call multiple times — the bus's
 * `setDispatcher()` is last-write-wins and there's no in-flight
 * state to leak. The `installed` flag only gates the one-time
 * startup log line.
 */
export function installAutomationBusDispatcher(): void {
    getAutomationBus().setDispatcher(bullmqAutomationDispatcher);
    if (!installed) {
        logger.info('automation-bus.dispatcher_installed', {
            component: 'bus-bootstrap',
            backend: 'bullmq',
        });
        installed = true;
    }
}
