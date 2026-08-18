/**
 * Deterministic correlation id for an outbound ServiceNow record.
 *
 * ═══ WHY THE DATABASE CONSTRAINT IS NOT ENOUGH, WHICH IS THE WHOLE POINT ═══
 *
 * `IntegrationSyncMapping` carries a unique constraint on both
 * (tenant, provider, localEntityType, localEntityId) and its remote twin, and
 * it is tempting to read that as "writes are idempotent". It is not, and the
 * gap is exactly where a retry lands.
 *
 * The mapping row and the remote record are written by two different systems
 * and cannot share a transaction:
 *
 *   1. push() creates the mapping (PENDING)
 *   2. the client POSTs to ServiceNow → INC0012345 exists
 *   3. the worker dies / the pod rolls / the response times out
 *   4. BullMQ retries (attempts: 3, exponential backoff — retry is the NORMAL
 *      case, not an edge case)
 *   5. push() finds the mapping, sees no remoteEntityId, POSTs again
 *      → INC0012346
 *
 * The constraint held perfectly throughout. There is ONE mapping row and TWO
 * incidents in somebody's ITSM queue, and the second will be worked by a human
 * before anybody notices.
 *
 * So the unique constraint makes the MAPPING idempotent. Only a correlation id
 * the REMOTE side can be queried by makes the WRITE idempotent. They do
 * different jobs, and only one of them is about duplicates in the ITSM queue.
 *
 * ═══ WHAT MAKES IT DETERMINISTIC ═══
 *
 * Derived only from identity that is stable across retries: tenant, provider,
 * local entity type and id. No timestamp, no attempt counter, no random —
 * anything that varies per attempt makes every retry a fresh record, which is
 * the defect wearing the fix's clothes.
 *
 * HASHED rather than concatenated, for two reasons that both matter:
 *   - `correlation_id` is a 40-character column in ServiceNow, and a cuid
 *     entity id plus a tenant id plus a type name overflows it. A truncated
 *     concatenation collides in a way nobody would predict.
 *   - it is written into a CUSTOMER'S instance, where our internal tenant and
 *     entity ids would otherwise sit in plain text, visible to every ITSM user
 *     and carried into every report they export.
 *
 * @module integrations/providers/servicenow/correlation
 */
import { createHash } from 'node:crypto';

/** Marks the record as ours in a customer's instance, and in their reports. */
export const CORRELATION_PREFIX = 'inflect:';

/** ServiceNow's correlation_id column is 40 characters. */
const MAX_CORRELATION_LENGTH = 40;
const HASH_LENGTH = MAX_CORRELATION_LENGTH - CORRELATION_PREFIX.length;

export interface CorrelationIdentity {
    tenantId: string;
    provider: string;
    localEntityType: string;
    localEntityId: string;
}

/**
 * The id ServiceNow will be queried by, and written with.
 *
 * The components are joined with a character that cannot appear in any of
 * them. A separator a component CAN contain lets two different entities hash
 * identically — ('a:b', 'c') and ('a', 'b:c') collide under ':' — and entity
 * TYPE names are free-form strings, so that is a reachable collision rather
 * than a theoretical one. A newline is not a legal component character here.
 */
export function correlationIdFor(identity: CorrelationIdentity): string {
    const material = [
        identity.tenantId,
        identity.provider,
        identity.localEntityType,
        identity.localEntityId,
    ].join('\n');
    const digest = createHash('sha256').update(material).digest('hex');
    return `${CORRELATION_PREFIX}${digest.slice(0, HASH_LENGTH)}`;
}

/** True for a correlation id this platform wrote. */
export function isInflectCorrelationId(value: string): boolean {
    return value.startsWith(CORRELATION_PREFIX);
}
