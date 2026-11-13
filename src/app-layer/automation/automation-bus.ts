/**
 * Automation event bus.
 *
 * In-process pub/sub that sits between usecase emitters and the
 * future rule dispatcher. Three responsibilities, in order:
 *
 *   1. Stamp the tenant-safe metadata every event needs (tenantId
 *      from RequestContext, emittedAt from the bus clock, actor from
 *      ctx). Producers never forge these.
 *   2. Fan the event out to in-process subscribers (wildcard + named)
 *      and isolate handler errors so a misbehaving handler can't
 *      sink the emission.
 *   3. Hand off to a pluggable *dispatcher* — a single entry point
 *      intended for later async-queue wiring. The default dispatcher
 *      is a no-op so the bus is usable before the job runner exists.
 *
 * Deliberately NOT in scope for this file:
 *   - rule matching against the DB (that's the dispatcher's job)
 *   - BullMQ enqueue (the dispatcher will wrap that)
 *   - execution row writes (AutomationExecutionRepository is the
 *     writer; the dispatcher decides when to invoke it)
 *
 * The bus is a process-wide singleton held on `globalThis` (see
 * `getAutomationBus` for why not a module-level one). Tests use
 * `resetAutomationBus()` between runs; production code should never need
 * to reset it.
 */

import { log } from '@/lib/observability';
import type { RequestContext } from '../types';
import type {
    AutomationDomainEvent,
    EmitAutomationEvent,
} from './event-contracts';
import type { AutomationEventName } from './events';

// ─── Public types ──────────────────────────────────────────────────────

export type AutomationEventHandler = (
    event: AutomationDomainEvent
) => void | Promise<void>;

/** Subscription handle — call to detach. */
export type Unsubscribe = () => void;

/**
 * Pluggable async-handoff seam. Default impl is in-process / no-op.
 * Later: swap in a BullMQ-backed dispatcher that enqueues a job
 * carrying the event and runs rule matching + action execution
 * outside the request path.
 */
export type AutomationDispatcher = (
    event: AutomationDomainEvent
) => void | Promise<void>;

export interface AutomationBus {
    emit(
        ctx: RequestContext,
        event: EmitAutomationEvent
    ): Promise<void>;
    subscribe(
        eventName: AutomationEventName | '*',
        handler: AutomationEventHandler
    ): Unsubscribe;
    setDispatcher(dispatcher: AutomationDispatcher): void;
    /** Test-only: drop all subscribers + restore default dispatcher. */
    reset(): void;
}

// ─── Implementation ────────────────────────────────────────────────────

const defaultDispatcher: AutomationDispatcher = () => {
    // No-op. The dispatcher epic will swap this.
};

function createAutomationBus(): AutomationBus {
    const subscribers = new Map<string, Set<AutomationEventHandler>>();
    let dispatcher: AutomationDispatcher = defaultDispatcher;

    async function runHandler(
        handler: AutomationEventHandler,
        event: AutomationDomainEvent,
        source: string
    ): Promise<void> {
        try {
            await handler(event);
        } catch (err) {
            // Handler errors must never block emission or poison other
            // handlers. Log + swallow — the dispatcher owns retries
            // and execution-row FAILED states.
            log('error', 'automation-bus.handler_failed', {
                event: event.event,
                tenantId: event.tenantId,
                source,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return {
        async emit(ctx, input) {
            const event: AutomationDomainEvent = {
                ...input,
                // Tenant ownership is non-forgeable: always from ctx.
                tenantId: ctx.tenantId,
                actorUserId: input.actorUserId ?? ctx.userId ?? null,
                emittedAt: new Date(),
            } as AutomationDomainEvent;

            log('debug', 'automation-bus.emit', {
                event: event.event,
                tenantId: event.tenantId,
                entityId: event.entityId,
            });

            const named = subscribers.get(event.event);
            const wild = subscribers.get('*');
            const handlers: AutomationEventHandler[] = [];
            if (named) handlers.push(...named);
            if (wild) handlers.push(...wild);

            // Run in-process subscribers first (synchronous observers
            // like test assertions, in-memory caches), then hand off
            // to the dispatcher for async/queued work.
            await Promise.all(
                handlers.map((h) => runHandler(h, event, 'subscriber'))
            );

            try {
                await dispatcher(event);
            } catch (err) {
                log('error', 'automation-bus.dispatcher_failed', {
                    event: event.event,
                    tenantId: event.tenantId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },

        subscribe(eventName, handler) {
            const set = subscribers.get(eventName) ?? new Set();
            set.add(handler);
            subscribers.set(eventName, set);
            return () => {
                const s = subscribers.get(eventName);
                if (!s) return;
                s.delete(handler);
                if (s.size === 0) subscribers.delete(eventName);
            };
        },

        setDispatcher(d) {
            dispatcher = d;
        },

        reset() {
            subscribers.clear();
            dispatcher = defaultDispatcher;
        },
    };
}

// ─── Process-wide singleton ────────────────────────────────────────────
//
// ON `globalThis`, NOT in a module-level `let`. Next.js bundles
// `instrumentation.ts` and the route handlers into DIFFERENT module
// instances of this file, so a module-level singleton gave the startup hook
// (which installs the BullMQ dispatcher) one bus and every route handler
// another, whose dispatcher was still the no-op default. Every automation
// event emitted from a web request — a task created on the Tasks page, a
// risk created through the API — was handed to that no-op and enqueued
// nothing: no `AutomationExecution` row, no rule ever fired. The worker was
// unaffected (esbuild bundles it as one graph). Found by the Inspect harness,
// whose Tool Runner samples start from a TASK_CREATED rule and waited for an
// execution that never came (run 43429583015). Same defect, same cause, as the
// provider registry (docs/implementation-notes/2026-07-08-provider-registry-request-path-fix.md);
// `globalThis` is the process, which both instances share, as the BullMQ
// queue in `jobs/queue.ts` already relies on.
//
// A Jest test file runs in its own global, so tests stay isolated.

const globalForBus = globalThis as unknown as {
    __inflectAutomationBus?: AutomationBus;
};

export function getAutomationBus(): AutomationBus {
    if (!globalForBus.__inflectAutomationBus) {
        globalForBus.__inflectAutomationBus = createAutomationBus();
    }
    return globalForBus.__inflectAutomationBus;
}

/**
 * Test-only: wipe the singleton's subscribers + dispatcher. Production
 * code never calls this; the bus is stateless across requests, so
 * "resetting" at runtime would drop legitimate subscribers.
 */
export function resetAutomationBus(): void {
    globalForBus.__inflectAutomationBus?.reset();
}

/**
 * Convenience wrapper for usecases. Hides the `getAutomationBus()`
 * lookup so emit sites stay one line:
 *
 *   await emitAutomationEvent(ctx, {
 *       event: 'RISK_CREATED',
 *       entityType: 'Risk',
 *       entityId: risk.id,
 *       actorUserId: ctx.userId,
 *       data: { title: risk.title, score: risk.score, category: null },
 *   });
 */
export async function emitAutomationEvent(
    ctx: RequestContext,
    event: EmitAutomationEvent
): Promise<void> {
    await getAutomationBus().emit(ctx, event);
}
