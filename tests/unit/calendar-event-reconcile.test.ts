/**
 * The four transitions, and the one that closes the leak.
 *
 * Handling three of four is the named failure mode, and the one usually missed
 * is DELETE — which here is not merely "the deadline was removed". A source the
 * user has LOST is skipped entirely by the aggregation and never appears in a
 * new generation, so it arrives at this function as an absence, exactly like a
 * deleted deadline. That is what makes the delete loop the mechanism that
 * closes C4's leak path, rather than any watch on permission changes.
 */
import {
    reconcileCalendarEvents,
    deleteAllForDisconnect,
    calendarClientEventId,
    calendarContentHash,
    type PushableEvent,
    type ExistingMapping,
} from '@/app-layer/usecases/calendar-event-reconcile';

const IDENTITY = { tenantId: 't1', userId: 'u1', provider: 'google-calendar' };

const ev = (over: Partial<PushableEvent> = {}): PushableEvent => ({
    sourceKey: 'task',
    sourceEntityId: 'task-1',
    title: 'SOC 2 evidence due',
    startsAt: '2026-09-01T09:00:00.000Z',
    ...over,
});

const mapped = (e: PushableEvent, over: Partial<ExistingMapping> = {}): ExistingMapping => ({
    sourceKey: e.sourceKey,
    sourceEntityId: e.sourceEntityId,
    remoteEventId: 'remote-1',
    clientEventId: calendarClientEventId({ ...IDENTITY, sourceKey: e.sourceKey, sourceEntityId: e.sourceEntityId }),
    contentHash: calendarContentHash(e),
    state: 'PUSHED',
    ...over,
});

describe('transition 1 — a new deadline is inserted', () => {
    it('emits insert with a deterministic client id', () => {
        const e = ev();
        const [a] = reconcileCalendarEvents({ identity: IDENTITY, desired: [e], existing: [] });
        expect(a.kind).toBe('insert');
        expect(a).toMatchObject({ clientEventId: calendarClientEventId({ ...IDENTITY, sourceKey: 'task', sourceEntityId: 'task-1' }) });
    });

    it('a mapping with NO remote id is re-inserted, not patched', () => {
        // The crash window: the previous attempt created the event and died
        // before recording the id. The deterministic client id is what makes
        // the retry a conflict rather than a second event.
        const e = ev();
        const [a] = reconcileCalendarEvents({
            identity: IDENTITY, desired: [e], existing: [mapped(e, { remoteEventId: '' })],
        });
        expect(a.kind).toBe('insert');
    });
});

describe('transition 2 — a changed deadline is patched', () => {
    it.each([
        ['title', { title: 'Renamed' }],
        ['start', { startsAt: '2026-09-02T09:00:00.000Z' }],
        ['end', { endsAt: '2026-09-01T10:00:00.000Z' }],
        ['description', { description: 'new note' }],
    ])('a changed %s produces a patch', (_field, change) => {
        // Every pushed field must be hashed. One that is pushed but not hashed
        // never triggers a patch, so an edit to it is silently never
        // propagated — the user sees a stale event forever.
        const before = ev();
        const after = ev(change as Partial<PushableEvent>);
        const [a] = reconcileCalendarEvents({
            identity: IDENTITY, desired: [after], existing: [mapped(before)],
        });
        expect(a.kind).toBe('patch');
        expect(a).toMatchObject({ remoteEventId: 'remote-1' });
    });

    it('an UNCHANGED deadline produces NO action at all', () => {
        // A nightly run over an unchanged calendar must make zero provider
        // calls, or the feature burns the user's rate limit doing nothing.
        const e = ev();
        expect(reconcileCalendarEvents({ identity: IDENTITY, desired: [e], existing: [mapped(e)] })).toEqual([]);
    });

    it('a FAILED row is re-pushed even when the content matches', () => {
        // The failure may have been the push itself, so "content unchanged"
        // says nothing about whether the remote actually has it.
        const e = ev();
        const [a] = reconcileCalendarEvents({
            identity: IDENTITY, desired: [e], existing: [mapped(e, { state: 'FAILED' })],
        });
        expect(a.kind).toBe('patch');
    });
});

describe('transition 3 — a deadline that is gone OR out of scope is deleted', () => {
    it('emits delete for a mapping with no matching desired event', () => {
        const gone = ev({ sourceEntityId: 'task-gone' });
        const actions = reconcileCalendarEvents({
            identity: IDENTITY, desired: [], existing: [mapped(gone)],
        });
        expect(actions).toEqual([
            { kind: 'delete', sourceKey: 'task', sourceEntityId: 'task-gone', remoteEventId: 'remote-1' },
        ]);
    });

    it('THE LEAK PATH: a source the user lost arrives as an absence and is deleted', () => {
        // This is C4. When a user is demoted, the aggregation skips that source
        // entirely — it never appears in a new generation — so it is
        // indistinguishable here from a deleted deadline, and gets the same
        // treatment. That is why the leak is closed by this loop rather than by
        // watching the 26 membership write sites, two of which write no
        // membership row at all.
        const incident = ev({ sourceKey: 'incident', sourceEntityId: 'inc-1', title: 'NIS2 notification deadline' });
        const task = ev();
        const actions = reconcileCalendarEvents({
            identity: IDENTITY,
            // Post-demotion: only the task source is still visible.
            desired: [task],
            existing: [mapped(task), mapped(incident, { remoteEventId: 'remote-incident' })],
        });
        expect(actions).toEqual([
            { kind: 'delete', sourceKey: 'incident', sourceEntityId: 'inc-1', remoteEventId: 'remote-incident' },
        ]);
    });

    it('a mapping that never reached the provider is NOT emitted as a delete', () => {
        // Nothing to remove remotely; emitting one would spend an API call and
        // then fail on an id the provider never issued.
        const gone = ev({ sourceEntityId: 'task-gone' });
        expect(
            reconcileCalendarEvents({ identity: IDENTITY, desired: [], existing: [mapped(gone, { remoteEventId: '' })] }),
        ).toEqual([]);
    });

    it('deletes and inserts coexist in one pass', () => {
        const kept = ev();
        const added = ev({ sourceEntityId: 'task-2' });
        const dropped = ev({ sourceEntityId: 'task-3' });
        const actions = reconcileCalendarEvents({
            identity: IDENTITY,
            desired: [kept, added],
            existing: [mapped(kept), mapped(dropped, { remoteEventId: 'remote-3' })],
        });
        expect(actions.map((a) => a.kind).sort()).toEqual(['delete', 'insert']);
    });
});

describe('transition 4 — disconnect removes everything', () => {
    it('emits a delete for every mapping that reached the provider', () => {
        const a = ev();
        const b = ev({ sourceEntityId: 'task-2' });
        const actions = deleteAllForDisconnect([mapped(a), mapped(b, { remoteEventId: 'remote-2' })]);
        expect(actions).toHaveLength(2);
        expect(actions.every((x) => x.kind === 'delete')).toBe(true);
    });

    it('does NOT route through the diff — removal must not need a successful generation', () => {
        // A disconnecting user may be one whose aggregation cannot run at all:
        // fully demoted, or a tenant whose calendar errors. Routing disconnect
        // through reconcileCalendarEvents would make removal conditional on
        // generating the set we are about to discard.
        const a = ev();
        expect(deleteAllForDisconnect([mapped(a)])).toHaveLength(1);
    });

    it('skips mappings with no remote id', () => {
        expect(deleteAllForDisconnect([mapped(ev(), { remoteEventId: '' })])).toEqual([]);
    });
});

describe('the client event id', () => {
    it('is stable across calls — nothing per-attempt in it', () => {
        const id = { ...IDENTITY, sourceKey: 'task', sourceEntityId: 'task-1' };
        expect(calendarClientEventId(id)).toBe(calendarClientEventId({ ...id }));
    });

    it('differs for every component of identity, INCLUDING userId', () => {
        // The userId case is the one that matters and the one a
        // tenant+entity-keyed scheme would miss: two users' copies of the SAME
        // deadline must not share an event id.
        const base = calendarClientEventId({ ...IDENTITY, sourceKey: 'task', sourceEntityId: 'task-1' });
        for (const over of [
            { tenantId: 't2' }, { userId: 'u2' }, { provider: 'outlook-calendar' },
            { sourceKey: 'incident' }, { sourceEntityId: 'task-2' },
        ]) {
            expect(calendarClientEventId({ ...IDENTITY, sourceKey: 'task', sourceEntityId: 'task-1', ...over })).not.toBe(base);
        }
    });

    it('is valid for Google — base32hex alphabet, within the length bounds', () => {
        // Google requires event ids to use digits 0-9 and letters a-v. Hex is a
        // strict subset. Base64 or a dashed uuid is NOT, and is rejected at
        // creation with an error that reads like a malformed request rather
        // than a malformed id.
        const id = calendarClientEventId({ ...IDENTITY, sourceKey: 'task', sourceEntityId: 'task-1' });
        expect(id).toMatch(/^[0-9a-v]+$/);
        expect(id.length).toBeGreaterThanOrEqual(5);
        expect(id.length).toBeLessThanOrEqual(1024);
    });

    it('does not collide when a component contains the separator', () => {
        const a = calendarClientEventId({ ...IDENTITY, sourceKey: 'ta\nsk', sourceEntityId: 'x' });
        const b = calendarClientEventId({ ...IDENTITY, sourceKey: 'ta', sourceEntityId: 'sk\nx' });
        expect(a).not.toBe(b);
    });
});
