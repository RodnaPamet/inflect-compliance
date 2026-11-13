/**
 * Bus ↔ BullMQ wiring.
 *
 * Call `installAutomationBusDispatcher(tier)` once at process startup
 * (`'web'` from `instrumentation.ts`, `'worker'` from `scripts/worker.ts`)
 * to swap the bus's default no-op dispatcher for one that enqueues an
 * `automation-event-dispatch` job per emitted event.
 *
 * THE TIER IS THE GATE POINT for `AUTOMATION_WEB_EVENTS_ENABLED`
 * (`web-events-switch.ts`). The web tier's dispatcher holds every event back
 * while the switch is off, as the web tier did before the bus was shared; the
 * worker's dispatcher never reads the switch, so a worker-tier event fires
 * exactly as it always has. Each process installs one dispatcher on its own
 * bus, so the two never meet.
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
import { AUTOMATION_WEB_EVENTS_SWITCH, automationWebEventsEnabled } from './web-events-switch';
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

let heldLogged = false;

/**
 * The WEB tier's dispatcher: the BullMQ one, behind the switch. With the switch
 * off the event is dropped, as every web event was before the bus was shared;
 * the first one dropped is logged once per process, so an operator can see
 * that the switch is holding events back.
 */
export const webAutomationDispatcher: AutomationDispatcher = async (event) => {
    if (!automationWebEventsEnabled()) {
        if (!heldLogged) {
            heldLogged = true;
            logger.info('automation-bus.web_events_held', {
                component: 'bus-bootstrap',
                switch: AUTOMATION_WEB_EVENTS_SWITCH,
                event: event.event,
                note: 'automation events emitted in the web process are not dispatched while the switch is off; logged once per process',
            });
        }
        return;
    }
    await bullmqAutomationDispatcher(event);
};

export type AutomationBusTier = 'web' | 'worker';

let installed = false;

/**
 * Wire the bus to enqueue one `automation-event-dispatch` job per
 * emission. Safe to call multiple times — the bus's
 * `setDispatcher()` is last-write-wins and there's no in-flight
 * state to leak. The `installed` flag only gates the one-time
 * startup log line. The tier is required, so no caller can forget
 * which side of the switch it is on.
 */
export function installAutomationBusDispatcher(tier: AutomationBusTier): void {
    getAutomationBus().setDispatcher(tier === 'web' ? webAutomationDispatcher : bullmqAutomationDispatcher);
    if (!installed) {
        logger.info('automation-bus.dispatcher_installed', {
            component: 'bus-bootstrap',
            backend: 'bullmq',
            tier,
            ...(tier === 'web' ? { webEventsEnabled: automationWebEventsEnabled() } : {}),
        });
        installed = true;
    }
}
