/**
 * The one idempotent outbound write.
 *
 * Every ServiceNow create goes through `ensureRemoteRecord`. It exists as a
 * single function rather than as steps inside an orchestrator method because
 * the ORDER of its three operations is the entire safety property, and an
 * order that lives inline gets rearranged by someone tidying up.
 *
 * ═══ THE ORDER, AND WHY EACH STEP IS WHERE IT IS ═══
 *
 *   1. mapping already carries a remoteEntityId  → UPDATE that record.
 *   2. otherwise, ASK THE REMOTE whether our correlation id already exists.
 *      → if it does, ADOPT it: record the id, do not create.
 *   3. only then, CREATE — stamped with the correlation id, so that if this
 *      process dies before step 4, the next attempt finds it at step 2.
 *   4. record the remote id.
 *
 * Step 2 is the whole fix. Without it the window between a successful POST and
 * a recorded id is a duplicate factory, and BullMQ's `attempts: 3` with
 * exponential backoff means that window is entered on every transient failure —
 * retry is the NORMAL case here, not an edge case. A duplicate is a duplicate
 * incident in somebody's ITSM queue, which a human will work before anyone
 * notices it was ours.
 *
 * ═══ WHAT THIS IS NOT ═══
 *
 * It is NOT check-then-create in the racing sense. A check-then-create race
 * needs two writers; the two things that would produce them are both already
 * closed:
 *
 *   - BullMQ retries a job SEQUENTIALLY. Attempt 2 begins after attempt 1 has
 *     ended, so a retry never races its own predecessor.
 *   - Two different jobs touching one connection are serialised by the
 *     per-connection sync lock (integrations/connection-lock.ts).
 *
 * So the read at step 2 is not a guess about a concurrent writer — it is a
 * recovery of what THIS logical write already did. That distinction is why a
 * remote-side unique index is not required for correctness here, and it is
 * stated because "check-then-create races" is true often enough to be applied
 * as a reflex to a case where it does not.
 *
 * If the remote is later written to concurrently by something outside this
 * lock, `findByCorrelationId` refusing on multiple matches is what surfaces it.
 *
 * @module integrations/providers/servicenow/outbound
 */
import type { RemoteObject } from '../../base-client';
import type { ServiceNowClient, ServiceNowRow } from './client';
import { correlationIdFor, type CorrelationIdentity } from './correlation';

export type OutboundAction = 'created' | 'adopted' | 'updated';

export interface EnsureRemoteRecordResult {
    remoteId: string;
    action: OutboundAction;
    record: RemoteObject<ServiceNowRow>;
    correlationId: string;
}

export interface EnsureRemoteRecordInput {
    client: Pick<ServiceNowClient, 'findByCorrelationId' | 'createRemoteObject' | 'updateRemoteObject'>;
    identity: CorrelationIdentity;
    /** The mapped remote fields to write. */
    data: Record<string, unknown>;
    /** Already-known remote id from the mapping row, when there is one. */
    knownRemoteId?: string | null;
    /**
     * Persist the remote id against the mapping. Called immediately after a
     * create or an adopt — never batched with anything else, because every
     * instruction between the remote write and this call widens the window the
     * whole design exists to close.
     */
    recordRemoteId: (remoteId: string) => Promise<void>;
}

export async function ensureRemoteRecord(
    input: EnsureRemoteRecordInput,
): Promise<EnsureRemoteRecordResult> {
    const correlationId = correlationIdFor(input.identity);

    // 1. Known record → update in place.
    if (input.knownRemoteId) {
        const record = await input.client.updateRemoteObject(input.knownRemoteId, input.data);
        return { remoteId: input.knownRemoteId, action: 'updated', record, correlationId };
    }

    // 2. Recover a record a previous attempt of THIS write already created.
    const existing = await input.client.findByCorrelationId(correlationId);
    if (existing) {
        await input.recordRemoteId(existing.remoteId);
        // Deliberately NOT followed by an update. The caller asked to ensure the
        // record exists; adopting and then immediately writing would turn a
        // recovery into a second mutation, and the interesting case for adopt
        // is a crash mid-create where the local data has not changed since.
        return { remoteId: existing.remoteId, action: 'adopted', record: existing, correlationId };
    }

    // 3. Create, stamped so step 2 can find it next time.
    const created = await input.client.createRemoteObject(input.data, correlationId);
    if (!created.remoteId) {
        // A create that returns no sys_id leaves a record we can never find
        // again by id — but it IS stamped, so the next attempt adopts it at
        // step 2. Failing loudly is right: continuing would record an empty id
        // and make the mapping permanently unlinkable.
        throw new Error('ServiceNow create returned no sys_id');
    }
    // 4. Record it. Nothing between this and the create.
    await input.recordRemoteId(created.remoteId);
    return { remoteId: created.remoteId, action: 'created', record: created, correlationId };
}
