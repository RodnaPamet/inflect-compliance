/**
 * The sweep that removes events a user may no longer see.
 *
 * ═══ WHY THIS IS A SWEEP AND NOT A HOOK ═══
 *
 * The obvious designs are to watch the cause — a membership write, an
 * automation event, an audit row. All three were investigated and all three are
 * wrong:
 *
 *   MEMBERSHIP WRITES are incomplete. `updateCustomRole` changes effective
 *   permissions for EVERY holder of a role with zero membership writes, and
 *   `Tenant.deletedAt` revokes everyone at once the same way. There are 26
 *   membership write sites across 9 files, and watching all 26 still misses
 *   those two.
 *
 *   AN AUTOMATION EVENT does not exist, and would not be safe if it did:
 *   `emitAutomationEvent` catches and logs its enqueue failure, so a Redis blip
 *   silently drops it. A dropped event here means events left in a third
 *   party's calendar permanently, with no retry and no detection.
 *
 *   AUDIT ROWS are written on some paths, swallowed by a try/catch on others,
 *   and absent entirely from the SCIM deprovisioning path — the one most likely
 *   to be the real revoke.
 *
 * So this observes the RESULT: recompute what the user may see NOW, from the
 * live membership, and remove whatever is pushed and no longer in that set. It
 * needs no knowledge of how the permission changed, which is why it cannot rot
 * when write site #27 lands. This file makes ZERO edits to those 9 files.
 *
 * ═══ THE TRADE, STATED PLAINLY ═══
 *
 * A leak window of up to one sweep interval. That is the cost of correctness
 * here, and it is why the REVOKE direction should run more often than the push:
 * recomputing permissions is cheap, and only the deletes touch a provider.
 *
 * ═══ THE RULE THAT MAKES IT SAFE TO RETRY ═══
 *
 * A remote delete that FAILS must not delete the mapping row. The row is the
 * only record the event exists; dropping it strands the event in the user's
 * calendar with nothing left to name it. It goes to PENDING_DELETE and the next
 * sweep tries again.
 *
 * @module usecases/calendar-reconcile-sweep
 */
import type { Locale } from '@/lib/locale-constants';
import { generatePushableEvents } from './calendar-push-generate';
import {
    reconcileCalendarEvents,
    deleteAllForDisconnect,
    type ExistingMapping,
    type PushableEvent,
    type ReconcileAction,
} from './calendar-event-reconcile';
import type { CalendarProviderId } from './user-calendar-connection';

/**
 * What the sweep needs a provider client to do. The two implementations are
 * `integrations/providers/calendar/{google,graph}-writer.ts`.
 */
export interface CalendarWriter {
    insert(input: { clientEventId: string; event: PushableEvent }): Promise<{ remoteEventId: string }>;
    /**
     * Update in place. May answer with a NEW id: an event the person deleted
     * by hand is gone at the provider (404/410), and the writer creates it
     * again — the sweep then records the id it was given, or the next patch
     * would go to the deleted one. `void` means the id is unchanged.
     */
    patch(input: { remoteEventId: string; event: PushableEvent }): Promise<void | { remoteEventId: string }>;
    remove(input: { remoteEventId: string }): Promise<void>;
}

/** The persistence the sweep needs. Kept narrow so it is trivially fakeable. */
export interface MappingStore {
    list(): Promise<ExistingMapping[]>;
    upsertPushed(input: {
        sourceKey: string;
        sourceEntityId: string;
        remoteEventId: string;
        clientEventId: string;
        contentHash: string;
    }): Promise<void>;
    markFailed(input: { sourceKey: string; sourceEntityId: string; error: string }): Promise<void>;
    /** The row is GONE — only after the remote event actually went. */
    drop(input: { sourceKey: string; sourceEntityId: string }): Promise<void>;
    /** Remote delete failed. Keep the row so the orphan stays nameable. */
    markPendingDelete(input: { sourceKey: string; sourceEntityId: string; error: string }): Promise<void>;
}

export interface SweepResult {
    /**
     * Actions left for the next run because this run reached its per-person
     * cap. A first push of a long backlog spreads over several nights instead
     * of meeting the provider's quota in one.
     */
    deferred: number;
    inserted: number;
    patched: number;
    deleted: number;
    /** Deletes that failed remotely. The rows survive in PENDING_DELETE. */
    deleteFailures: number;
    /** Pushes that failed. The rows survive in FAILED. */
    pushFailures: number;
    /** True when the user may see nothing, or is no longer an active member. */
    removedEverything: boolean;
    changed: boolean;
}

/**
 * Reconcile one user's calendar for one provider.
 *
 * Returns counts rather than throwing on a per-event failure: one bad event
 * must not abandon the rest of a user's calendar half-reconciled, and one bad
 * USER must not abort the batch — that isolation is `runUserPushGuarded`'s job
 * one level up, and this must not undermine it by throwing past it.
 *
 * A failure that is the CONNECTION's problem rather than one event's — a
 * revoked token, a throttle — still propagates, because it applies to every
 * event and retrying the remaining ones would just repeat it.
 */
export async function sweepUserCalendar(
    input: {
        tenantId: string;
        userId: string;
        provider: CalendarProviderId;
        /** The workspace's default language, for the product's own wording. */
        locale?: Locale;
        /** The deployment's public origin, for the link back to the item. */
        publicOrigin?: string | null;
    },
    deps: {
        store: MappingStore;
        writer: CalendarWriter;
        generate?: typeof generatePushableEvents;
        now?: () => Date;
        /** Provider calls this run may make for this person. Unbounded when absent. */
        maxActions?: number;
    },
): Promise<SweepResult> {
    const generate = deps.generate ?? generatePushableEvents;
    const existing = await deps.store.list();

    const outcome = await generate(
        {
            tenantId: input.tenantId,
            userId: input.userId,
            locale: input.locale,
            publicOrigin: input.publicOrigin,
        },
        { now: deps.now },
    );

    // BOTH of these mean "remove everything", and they are reached by different
    // routes: a removed member, and an active member who may no longer see any
    // calendar source. Neither is an error, and neither may be treated as
    // "nothing due" — that is the distinction C3's outcome type exists to draw.
    if (outcome.kind === 'refused' || outcome.kind === 'no-visible-sources') {
        const result = await applyActions(deleteAllForDisconnect(existing), deps);
        return { ...result, removedEverything: true, changed: result.deleted > 0 };
    }

    const actions = reconcileCalendarEvents({
        identity: { tenantId: input.tenantId, userId: input.userId, provider: input.provider },
        desired: outcome.events,
        existing,
        holdDeletes: outcome.held
            ? { sourceKeys: new Set(outcome.held.sourceKeys), all: outcome.held.all }
            : undefined,
    });
    const result = await applyActions(actions, deps);
    return {
        ...result,
        removedEverything: false,
        changed: result.inserted + result.patched + result.deleted > 0,
    };
}

/**
 * Remove every event this connection pushed, and nothing else. The disconnect
 * path, and the nightly retry of a disconnect whose removals did not all
 * succeed.
 *
 * Runs no generation: a disconnect must remove events even when the person
 * may no longer see anything, or the aggregation is failing. `remaining` is
 * what is still recorded afterwards — rows whose removal failed (kept in
 * PENDING_DELETE) and rows the cap left for the next run.
 */
export async function removeAllPushedEvents(deps: {
    store: MappingStore;
    writer: CalendarWriter;
    maxActions?: number;
}): Promise<{ deleted: number; deleteFailures: number; deferred: number; remaining: number }> {
    const existing = await deps.store.list();
    const result = await applyActions(deleteAllForDisconnect(existing), deps);
    return {
        deleted: result.deleted,
        deleteFailures: result.deleteFailures,
        deferred: result.deferred,
        remaining: existing.filter((m) => m.remoteEventId).length - result.deleted,
    };
}

async function applyActions(
    all: readonly ReconcileAction[],
    deps: { store: MappingStore; writer: CalendarWriter; maxActions?: number },
): Promise<Omit<SweepResult, 'removedEverything' | 'changed'>> {
    // REMOVALS FIRST. They are the revoke direction — an event the person may
    // no longer see — and must never wait behind a backlog of new deadlines
    // when the per-person cap bites. Within each kind the reconciler's order
    // stands: desired events arrive date-ascending, so the nearest go first.
    const ordered = [...all.filter((a) => a.kind === 'delete'), ...all.filter((a) => a.kind !== 'delete')];
    const cap = deps.maxActions ?? ordered.length;
    const actions = ordered.slice(0, Math.max(0, cap));
    const deferred = ordered.length - actions.length;

    let inserted = 0;
    let patched = 0;
    let deleted = 0;
    let deleteFailures = 0;
    let pushFailures = 0;

    for (const action of actions) {
        try {
            if (action.kind === 'insert') {
                const { remoteEventId } = await deps.writer.insert({
                    clientEventId: action.clientEventId,
                    event: action.event,
                });
                // Recorded IMMEDIATELY. Every instruction between the remote
                // write and this call widens the window where a crash leaves an
                // event we cannot name.
                await deps.store.upsertPushed({
                    sourceKey: action.event.sourceKey,
                    sourceEntityId: action.event.sourceEntityId,
                    remoteEventId,
                    clientEventId: action.clientEventId,
                    contentHash: action.contentHash,
                });
                inserted += 1;
            } else if (action.kind === 'patch') {
                const answered = await deps.writer.patch({ remoteEventId: action.remoteEventId, event: action.event });
                await deps.store.upsertPushed({
                    sourceKey: action.event.sourceKey,
                    sourceEntityId: action.event.sourceEntityId,
                    // A re-created event has a new id; record it IMMEDIATELY,
                    // as for an insert.
                    remoteEventId: answered?.remoteEventId ?? action.remoteEventId,
                    clientEventId: '',
                    contentHash: action.contentHash,
                });
                patched += 1;
            } else {
                await deps.writer.remove({ remoteEventId: action.remoteEventId });
                // ONLY NOW. The row is the sole record the event existed, so it
                // goes after the remote event does — never before, never
                // optimistically.
                await deps.store.drop({ sourceKey: action.sourceKey, sourceEntityId: action.sourceEntityId });
                deleted += 1;
            }
        } catch (err) {
            if (isConnectionLevel(err)) throw err;
            const message = truncate(err);
            if (action.kind === 'delete') {
                // KEEP THE ROW. Dropping it here is the one mistake that cannot
                // be recovered from: the event stays in the user's calendar and
                // nothing local remembers it.
                await deps.store.markPendingDelete({
                    sourceKey: action.sourceKey,
                    sourceEntityId: action.sourceEntityId,
                    error: message,
                });
                deleteFailures += 1;
            } else {
                await deps.store.markFailed({
                    sourceKey: action.event.sourceKey,
                    sourceEntityId: action.event.sourceEntityId,
                    error: message,
                });
                pushFailures += 1;
            }
        }
    }

    return { deferred, inserted, patched, deleted, deleteFailures, pushFailures };
}

/**
 * Does this failure apply to the whole CONNECTION rather than one event?
 *
 * A revoked token or a throttle will fail every remaining event identically, so
 * grinding through them wastes a rate-limit budget the user is already short of
 * and buries the real cause under fifty identical rows. Those propagate to
 * `runUserPushGuarded`, which is where revocation is recorded.
 *
 * Detected by NAME rather than `instanceof`, deliberately: this module must not
 * import the integrations HTTP layer. That layer reaches `resilientFetch` and
 * its transitive imports, and this runs in the BullMQ worker — the same class of
 * edge that made the aggregation unimportable there until it was cut.
 */
function isConnectionLevel(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'IntegrationAuthError' || name === 'IntegrationRateLimitedError';
}

/** Operator-facing, bounded. Never rendered to the user. */
function truncate(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
