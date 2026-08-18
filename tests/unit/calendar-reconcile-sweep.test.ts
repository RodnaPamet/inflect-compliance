/**
 * Demote a user and their events LEAVE the calendar.
 *
 * The DONE criterion is explicit that "absent from the next generation" is not
 * enough — the remote events must be GONE. So the central test drives the whole
 * sequence against a fake calendar that actually holds events: push as a
 * permissioned user, demote them, sweep, and assert the calendar is empty.
 *
 * That is C4, and it is distinct from C3. C3 stops NEW leaks at generation time.
 * Passing C3 tells you nothing about whether what was already pushed comes back
 * out.
 *
 * ═══ WHY THIS IS A SWEEP ═══
 *
 * Not because a hook would be harder, but because every cause-side signal is
 * incomplete or unreliable: `updateCustomRole` changes effective permissions for
 * every holder of a role with ZERO membership writes, no automation event
 * exists (and `emitAutomationEvent` swallows enqueue failures anyway), and the
 * SCIM deprovisioning path — the likeliest real revoke — writes no
 * MEMBER_ROLE_CHANGED audit row at all.
 *
 * Observing the RESULT needs none of that, which is why these tests never
 * simulate a permission-change event. They simulate a permission-changed WORLD.
 */
import { sweepUserCalendar, type MappingStore, type CalendarWriter } from '@/app-layer/usecases/calendar-reconcile-sweep';
import { calendarClientEventId, calendarContentHash, type ExistingMapping, type PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';

const IDENTITY = { tenantId: 't1', userId: 'u1', provider: 'google-calendar' as const };

const taskEvent: PushableEvent = {
    sourceKey: 'TASK', sourceEntityId: 'task-1',
    title: 'Evidence review', startsAt: '2026-09-01T00:00:00.000Z', endsAt: null, description: null,
};
const incidentEvent: PushableEvent = {
    sourceKey: 'INCIDENT_NOTIFICATION', sourceEntityId: 'inc-1',
    title: 'NIS2 notification due', startsAt: '2026-09-02T00:00:00.000Z', endsAt: null, description: null,
};

/** A calendar that really holds events, so "gone" can be asserted. */
function fakeCalendar(opts: { failRemove?: boolean; failInsert?: boolean } = {}) {
    const events = new Map<string, { clientEventId: string }>();
    let n = 0;
    const writer: CalendarWriter = {
        async insert({ clientEventId }) {
            if (opts.failInsert) throw new Error('insert exploded');
            const remoteEventId = `remote-${++n}`;
            events.set(remoteEventId, { clientEventId });
            return { remoteEventId };
        },
        async patch() { /* content only */ },
        async remove({ remoteEventId }) {
            if (opts.failRemove) throw new Error('remove exploded');
            events.delete(remoteEventId);
        },
    };
    return { events, writer };
}

/** A mapping store that really persists, so orphans can be detected. */
function fakeStore(seed: ExistingMapping[] = []) {
    const rows = new Map<string, ExistingMapping>(seed.map((m) => [`${m.sourceKey}|${m.sourceEntityId}`, m]));
    const k = (a: string, b: string) => `${a}|${b}`;
    const store: MappingStore = {
        async list() { return [...rows.values()]; },
        async upsertPushed({ sourceKey, sourceEntityId, remoteEventId, clientEventId, contentHash }) {
            rows.set(k(sourceKey, sourceEntityId), { sourceKey, sourceEntityId, remoteEventId, clientEventId, contentHash, state: 'PUSHED' });
        },
        async markFailed({ sourceKey, sourceEntityId }) {
            const r = rows.get(k(sourceKey, sourceEntityId));
            if (r) rows.set(k(sourceKey, sourceEntityId), { ...r, state: 'FAILED' });
        },
        async drop({ sourceKey, sourceEntityId }) { rows.delete(k(sourceKey, sourceEntityId)); },
        async markPendingDelete({ sourceKey, sourceEntityId }) {
            const r = rows.get(k(sourceKey, sourceEntityId));
            if (r) rows.set(k(sourceKey, sourceEntityId), { ...r, state: 'PENDING_DELETE' });
        },
    };
    return { rows, store };
}

const generated = (events: PushableEvent[]) =>
    (async () => ({ kind: 'generated' as const, events, omittedSources: [] }));

describe('THE LEAK PATH: demote a user and the events leave the calendar', () => {
    it('push as permissioned → demote → sweep → the remote events are GONE', async () => {
        const cal = fakeCalendar();
        const st = fakeStore();

        // 1. Push as a user who can see both sources.
        const first = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: generated([taskEvent, incidentEvent]) as never,
        });
        expect(first.inserted).toBe(2);
        expect(cal.events.size).toBe(2);
        expect(st.rows.size).toBe(2);

        // 2. Demote: incidents are no longer visible, so the aggregation simply
        //    stops producing them. No event fires; nothing tells us.
        const second = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: generated([taskEvent]) as never,
        });

        // 3. THE ASSERTION THIS FILE EXISTS FOR — gone from the calendar, not
        //    merely absent from a regeneration.
        expect(second.deleted).toBe(1);
        expect(cal.events.size).toBe(1);
        expect(st.rows.size).toBe(1);
        expect([...st.rows.keys()]).toEqual(['TASK|task-1']);
    });

    it('a FULLY demoted user has their whole calendar cleared', async () => {
        const cal = fakeCalendar();
        const st = fakeStore();
        await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent, incidentEvent]) as never,
        });
        expect(cal.events.size).toBe(2);

        // `no-visible-sources`, NOT an empty generation. Treating this as
        // "nothing due" would leave both events in place forever.
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: (async () => ({ kind: 'no-visible-sources' as const, omittedSources: ['tasks', 'incidents'] })) as never,
        });
        expect(out.removedEverything).toBe(true);
        expect(cal.events.size).toBe(0);
        expect(st.rows.size).toBe(0);
    });

    it('a REMOVED member has their whole calendar cleared', async () => {
        const cal = fakeCalendar();
        const st = fakeStore();
        await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent]) as never,
        });
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: (async () => ({ kind: 'refused' as const, reason: 'not-an-active-member' })) as never,
        });
        expect(out.removedEverything).toBe(true);
        expect(cal.events.size).toBe(0);
    });

    it('an EMPTY WINDOW does not clear anything', async () => {
        // The mirror failure. A quiet week must not wipe the calendar — which
        // is exactly why C3 distinguishes no-visible-sources from an empty
        // generation, and why this sweep keys on that distinction.
        const cal = fakeCalendar();
        const st = fakeStore();
        await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent]) as never,
        });
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: (async () => ({ kind: 'generated' as const, events: [], omittedSources: [] })) as never,
        });
        // The task genuinely is no longer due, so it goes — but via the normal
        // diff, not the clear-everything path.
        expect(out.removedEverything).toBe(false);
        expect(out.deleted).toBe(1);
    });
});

describe('a failed remote delete keeps the row', () => {
    it('marks PENDING_DELETE rather than dropping it', async () => {
        // The one mistake that cannot be recovered from: drop the row and the
        // event stays in the user's calendar with nothing local remembering it.
        const cal = fakeCalendar();
        const st = fakeStore();
        await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent]) as never,
        });

        const failing = fakeCalendar({ failRemove: true });
        // Reuse the store, swap in a writer whose remove always throws.
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: failing.writer,
            generate: (async () => ({ kind: 'generated' as const, events: [], omittedSources: [] })) as never,
        });

        expect(out.deleteFailures).toBe(1);
        expect(out.deleted).toBe(0);
        // The row SURVIVES, so the next sweep can try again.
        expect(st.rows.size).toBe(1);
        expect([...st.rows.values()][0].state).toBe('PENDING_DELETE');
    });

    it('the next sweep retries it and succeeds', async () => {
        const st = fakeStore([{
            sourceKey: 'TASK', sourceEntityId: 'task-1', remoteEventId: 'remote-1',
            clientEventId: calendarClientEventId({ ...IDENTITY, sourceKey: 'TASK', sourceEntityId: 'task-1' }),
            contentHash: calendarContentHash(taskEvent), state: 'PENDING_DELETE',
        }]);
        const cal = fakeCalendar();
        cal.events.set('remote-1', { clientEventId: 'x' });
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer,
            generate: (async () => ({ kind: 'generated' as const, events: [], omittedSources: [] })) as never,
        });
        expect(out.deleted).toBe(1);
        expect(cal.events.size).toBe(0);
        expect(st.rows.size).toBe(0);
    });
});

describe('one bad event does not abandon the rest', () => {
    it('a failed insert is marked FAILED and the sweep continues', async () => {
        const cal = fakeCalendar({ failInsert: true });
        const st = fakeStore();
        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent, incidentEvent]) as never,
        });
        expect(out.pushFailures).toBe(2);
        expect(out.inserted).toBe(0);
    });

    it('a CONNECTION-level failure propagates instead of grinding through', async () => {
        // A revoked token fails every remaining event identically. Grinding
        // through wastes a rate-limit budget the user is already short of and
        // buries the cause under fifty identical rows. It belongs to
        // runUserPushGuarded, which is where revocation is recorded.
        const authErr = Object.assign(new Error('401'), { name: 'IntegrationAuthError' });
        const writer: CalendarWriter = {
            async insert() { throw authErr; },
            async patch() { /* unused */ },
            async remove() { /* unused */ },
        };
        const st = fakeStore();
        await expect(
            sweepUserCalendar(IDENTITY, { store: st.store, writer, generate: generated([taskEvent]) as never }),
        ).rejects.toBe(authErr);
    });

    it('a THROTTLE propagates too', async () => {
        const rateErr = Object.assign(new Error('429'), { name: 'IntegrationRateLimitedError' });
        const writer: CalendarWriter = {
            async insert() { throw rateErr; }, async patch() {}, async remove() {},
        };
        await expect(
            sweepUserCalendar(IDENTITY, { store: fakeStore().store, writer, generate: generated([taskEvent]) as never }),
        ).rejects.toBe(rateErr);
    });
});

describe('an unchanged calendar is left alone', () => {
    it('a second identical sweep writes nothing', async () => {
        // A nightly run over an unchanged calendar must make zero provider
        // calls, or per-user push burns every user's rate limit doing nothing.
        const cal = fakeCalendar();
        const st = fakeStore();
        await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent]) as never,
        });
        const insertSpy = jest.spyOn(cal.writer, 'insert');
        const patchSpy = jest.spyOn(cal.writer, 'patch');
        const removeSpy = jest.spyOn(cal.writer, 'remove');

        const out = await sweepUserCalendar(IDENTITY, {
            store: st.store, writer: cal.writer, generate: generated([taskEvent]) as never,
        });
        expect(out.changed).toBe(false);
        expect(insertSpy).not.toHaveBeenCalled();
        expect(patchSpy).not.toHaveBeenCalled();
        expect(removeSpy).not.toHaveBeenCalled();
    });
});

describe('the sweep needs no knowledge of how permissions changed', () => {
    it('never imports the integrations HTTP layer', () => {
        // Two reasons, and the second is the one that bites: this runs in the
        // BullMQ worker, and importing the integrations HTTP layer reaches
        // transitive imports of the kind that made the calendar aggregation
        // unimportable there until #1990 cut the edge. Connection-level errors
        // are therefore detected by NAME.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        const src = fs.readFileSync(
            require('node:path').resolve(__dirname, '../../src/app-layer/usecases/calendar-reconcile-sweep.ts'),
            'utf8',
        );
        expect(src).not.toMatch(/from '.*integrations\/http-resilience'/);
        expect(src).not.toMatch(/from '@\/lib\/security\/permission-middleware'/);
    });
});
