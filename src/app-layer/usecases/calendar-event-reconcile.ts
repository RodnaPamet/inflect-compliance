/**
 * Reconciling what a user SHOULD have in their calendar against what they DO.
 *
 * Four transitions, and the failure mode is handling three:
 *
 *   deadline created              → INSERT   create remotely, record the id
 *   date / title changed          → PATCH    update in place
 *   deadline gone or out of scope → DELETE   remove remotely, then drop the row
 *   user disconnects              → DELETE ALL, and only then drop the token
 *
 * ═══ THE DELETE DIRECTION IS DRIVEN BY THE MAPPING TABLE ═══
 *
 * Not by diffing a regenerated event set against itself. A source the user has
 * LOST is skipped entirely by the compliance-calendar aggregation — it never
 * appears in a new generation at all — so "push the new set" leaves orphans
 * that nothing ever mentions again. The mapping row is the only record the
 * event exists, which makes it the only thing that can name what to remove.
 *
 * ═══ THE ORDERING ON DISCONNECT ═══
 *
 * Delete the remote events FIRST, drop the token AFTER. Reversed, the token is
 * gone and the events sit in the user's personal calendar with no credential
 * left to reach them — permanently, and visibly to them.
 *
 * ═══ IDEMPOTENCY ═══
 *
 * The queue retries. A retry that CREATES rather than PATCHES puts a duplicate
 * in someone's personal calendar, which is the most visible way this feature
 * can fail: the user sees it and we do not.
 *
 * Two mechanisms, because either alone has a gap:
 *   - the stored `remoteEventId` covers the case where the previous attempt
 *     completed and we recorded it;
 *   - the deterministic `clientEventId`, supplied at CREATION, covers the case
 *     where the previous attempt created the event and died before recording
 *     the id. Both providers accept a caller-specified id and reject a
 *     duplicate, so the retry gets a conflict instead of a second event.
 *
 * @module usecases/calendar-event-reconcile
 */
import { createHash } from 'node:crypto';

/** What one generated deadline looks like to the pusher. */
export interface PushableEvent {
    /** Which calendar source produced it, e.g. 'task', 'incident'. */
    sourceKey: string;
    /** The source row's id. */
    sourceEntityId: string;
    title: string;
    /** ISO date or date-time — whatever the provider will be given. */
    startsAt: string;
    endsAt?: string | null;
    description?: string | null;
}

/** A mapping row, reduced to what reconciliation needs. */
export interface ExistingMapping {
    sourceKey: string;
    sourceEntityId: string;
    remoteEventId: string;
    clientEventId: string;
    contentHash: string;
    state: 'PUSHED' | 'PENDING_DELETE' | 'FAILED';
}

export type ReconcileAction =
    | { kind: 'insert'; event: PushableEvent; clientEventId: string; contentHash: string }
    | { kind: 'patch'; event: PushableEvent; remoteEventId: string; contentHash: string }
    | { kind: 'delete'; sourceKey: string; sourceEntityId: string; remoteEventId: string };

/**
 * A stable id for one (user, provider, deadline).
 *
 * LOWERCASE HEX, and that is a constraint rather than a preference. Google
 * requires event ids to use the base32hex alphabet — digits 0-9 and letters
 * a-v. Hex is a strict subset of that, so a hex digest is valid as-is. Base64
 * or a raw uuid with dashes is NOT, and would be rejected at creation with an
 * error that reads like a malformed request rather than a malformed id.
 *
 * Derived only from identity that is stable across retries. Anything
 * per-attempt makes every retry a fresh event — the defect wearing the fix's
 * clothes.
 *
 * LENGTH-PREFIXED rather than joined on a separator, and this is the second
 * attempt. A separator only works if no component can contain it — and I first
 * used `\n` on the claim that none could. Source keys and entity ids are
 * free-form strings, so that claim was false, and the test below proved it:
 * ('ta\nsk', 'x') and ('ta', 'sk\nx') hashed identically, which is two
 * different deadlines sharing one calendar event.
 *
 * Length-prefixing is unambiguous whatever the content, so there is no
 * character left to be wrong about.
 */
export function calendarClientEventId(identity: {
    tenantId: string;
    userId: string;
    provider: string;
    sourceKey: string;
    sourceEntityId: string;
}): string {
    const material = [
        identity.tenantId,
        identity.userId,
        identity.provider,
        identity.sourceKey,
        identity.sourceEntityId,
    ]
        .map((c) => `${c.length}:${c}`)
        .join('');
    // Google's floor is 5 characters and its ceiling 1024; 40 hex chars sits
    // safely inside both and matches the collision margin used elsewhere.
    return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

/**
 * Hash of everything we push, so a change is detected without reading back.
 *
 * Reading the remote event to compare would need a scope we deliberately do not
 * request, and would cost one API call per event per run.
 *
 * The field list here IS the contract: a field pushed but not hashed will never
 * trigger a patch, so an edit to it is silently never propagated. That is why
 * this takes the whole event rather than a caller-chosen subset.
 */
export function calendarContentHash(event: PushableEvent): string {
    const material = JSON.stringify([
        event.title,
        event.startsAt,
        event.endsAt ?? null,
        event.description ?? null,
    ]);
    return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Map key for one (sourceKey, sourceEntityId).
 *
 * Length-prefixed for the same reason as the client id, and it matters MORE
 * here: a collision does not merely duplicate an event, it matches a desired
 * event against the WRONG mapping — patching some other deadline's remote event
 * and leaving a real orphan undeleted.
 */
function key(sourceKey: string, sourceEntityId: string): string {
    return `${sourceKey.length}:${sourceKey}${sourceEntityId.length}:${sourceEntityId}`;
}

/**
 * Diff the events a user should have against the mappings they do have.
 *
 * Pure — no database, no provider. The interesting cases are set shapes, and
 * they should be writable as fixtures rather than as fetch mocks.
 */
export function reconcileCalendarEvents(input: {
    identity: { tenantId: string; userId: string; provider: string };
    /** What the aggregation produced for THIS user, under THEIR permissions. */
    desired: readonly PushableEvent[];
    /** Every mapping row this user currently has for this provider. */
    existing: readonly ExistingMapping[];
}): ReconcileAction[] {
    const actions: ReconcileAction[] = [];
    const existingByKey = new Map(input.existing.map((m) => [key(m.sourceKey, m.sourceEntityId), m]));
    const desiredKeys = new Set<string>();

    for (const event of input.desired) {
        const k = key(event.sourceKey, event.sourceEntityId);
        desiredKeys.add(k);
        const hash = calendarContentHash(event);
        const found = existingByKey.get(k);

        if (!found || !found.remoteEventId) {
            // Never pushed, or pushed and the id never recorded. Either way the
            // deterministic client id is what stops a duplicate.
            actions.push({
                kind: 'insert',
                event,
                clientEventId: calendarClientEventId({ ...input.identity, sourceKey: event.sourceKey, sourceEntityId: event.sourceEntityId }),
                contentHash: hash,
            });
            continue;
        }
        // A row left FAILED gets re-pushed even when the hash matches: the
        // failure may have been the push itself, so "content unchanged" says
        // nothing about whether the remote has it.
        if (found.contentHash !== hash || found.state === 'FAILED') {
            actions.push({ kind: 'patch', event, remoteEventId: found.remoteEventId, contentHash: hash });
        }
        // Matching hash, state PUSHED → nothing to do. Not emitting a no-op
        // action is the point: a nightly run over an unchanged calendar must
        // make zero provider calls, or the feature burns a user's rate limit
        // doing nothing.
    }

    for (const m of input.existing) {
        if (desiredKeys.has(key(m.sourceKey, m.sourceEntityId))) continue;
        if (!m.remoteEventId) continue; // never made it remote; the row is just noise
        // Absent from `desired` means one of: the deadline was deleted, it fell
        // out of the window, or THE USER LOST THE PERMISSION THAT SHOWED IT.
        // The three are indistinguishable here and the response is the same —
        // which is exactly why C4's leak path is closed by this loop rather
        // than by watching permission changes.
        actions.push({
            kind: 'delete',
            sourceKey: m.sourceKey,
            sourceEntityId: m.sourceEntityId,
            remoteEventId: m.remoteEventId,
        });
    }

    return actions;
}

/**
 * Every mapping for a user, as deletes. The disconnect path.
 *
 * Separate from `reconcileCalendarEvents` rather than "reconcile against an
 * empty desired set", because the two differ where it matters: a disconnect
 * must remove events even when the aggregation cannot run — a demoted user
 * whose sources are all omitted, or a tenant whose calendar errors — and
 * routing it through the diff would make removal conditional on a successful
 * generation.
 */
export function deleteAllForDisconnect(existing: readonly ExistingMapping[]): ReconcileAction[] {
    return existing
        .filter((m) => m.remoteEventId)
        .map((m) => ({
            kind: 'delete' as const,
            sourceKey: m.sourceKey,
            sourceEntityId: m.sourceEntityId,
            remoteEventId: m.remoteEventId,
        }));
}
