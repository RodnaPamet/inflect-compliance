/**
 * A user who cannot see a source gets no events from it.
 *
 * The DONE criterion is "run the pusher under two different permission sets",
 * so the central test does exactly that: the SAME deadlines, the SAME code
 * path, two contexts — and the filtering is done by the real aggregation's own
 * per-source gate rather than by anything this module adds.
 *
 * That is the point of C3. The compliance calendar deliberately does not gate
 * once and then read nineteen domains, because `ctx.permissions.canRead` is
 * true for every role and a coarse gate would show a READER the incident and
 * personnel deadlines. Adding a second, "simpler" query path for the pusher is
 * how the two diverge and the permission filtering quietly stops applying —
 * and the pusher is the copy nobody looks at.
 */
import {
    generatePushableEvents,
    PUSH_WINDOW_DAYS,
} from '@/app-layer/usecases/calendar-push-generate';
import { hasPermission } from '@/lib/security/permission-key';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import type { getComplianceCalendarEvents } from '@/app-layer/usecases/compliance-calendar';

const NOW = new Date('2026-08-18T00:00:00.000Z');

/** Two deadlines from two different sources, with their gating keys. */
const SOURCES = [
    { name: 'incidents', permission: 'incidents.view', entityType: 'INCIDENT_NOTIFICATION', entityId: 'inc-1', title: 'NIS2 notification due' },
    { name: 'tasks', permission: 'tasks.view', entityType: 'TASK', entityId: 'task-1', title: 'Evidence review' },
] as const;

/**
 * A stand-in for the real aggregation that reproduces the ONE behaviour under
 * test: a per-source permission gate, with the refused sources reported rather
 * than silently dropped. It calls the REAL `hasPermission` against the REAL
 * context, so a change to permission resolution is felt here.
 */
const fakeAggregate = jest.fn<
    Promise<never>,
    Parameters<typeof getComplianceCalendarEvents>
>(async (ctx: RequestContext) => {
    const omittedSources: string[] = [];
    const events = [];
    for (const s of SOURCES) {
        if (!hasPermission(ctx.appPermissions, s.permission as never)) {
            omittedSources.push(s.name);
            continue;
        }
        events.push({
            id: `${s.entityType}:${s.entityId}:DUE`,
            entityType: s.entityType,
            entityId: s.entityId,
            title: s.title,
            date: '2026-09-01T00:00:00.000Z',
            detail: 'assigned to you',
        });
    }
    return { events, omittedSources, erroredSources: [] } as never;
});

function ctxFor(over: Partial<RequestContext> = {}): RequestContext {
    return { ...makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' }), ...over };
}

/** Strip one domain's permissions, leaving the rest intact. */
function withoutDomain(base: RequestContext, domain: string): RequestContext {
    const appPermissions = JSON.parse(JSON.stringify(base.appPermissions));
    for (const k of Object.keys(appPermissions[domain] ?? {})) appPermissions[domain][k] = false;
    return { ...base, appPermissions };
}

beforeEach(() => jest.clearAllMocks());

describe('the same generation under two permission sets', () => {
    it('a user with both permissions gets both events', async () => {
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: fakeAggregate, now: () => NOW },
        );
        expect(out.kind).toBe('generated');
        if (out.kind !== 'generated') throw new Error('unreachable');
        expect(out.events.map((e) => e.sourceEntityId).sort()).toEqual(['inc-1', 'task-1']);
        expect(out.omittedSources).toEqual([]);
    });

    it('a user WITHOUT incidents.view gets no incident event, and it is named as omitted', async () => {
        // The assertion C3 exists for. Same deadlines, same code path, one
        // permission removed — and the source is REPORTED rather than silently
        // dropped, so the caller can tell "hidden" from "nothing due".
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            {
                resolveContext: async () => withoutDomain(ctxFor(), 'incidents'),
                aggregate: fakeAggregate,
                now: () => NOW,
            },
        );
        expect(out.kind).toBe('generated');
        if (out.kind !== 'generated') throw new Error('unreachable');
        expect(out.events.map((e) => e.sourceEntityId)).toEqual(['task-1']);
        expect(out.events.some((e) => e.sourceKey === 'INCIDENT_NOTIFICATION')).toBe(false);
        expect(out.omittedSources).toEqual(['incidents']);
    });

    it('the filtering is the AGGREGATION’s, not this module’s', async () => {
        // This module must add no filtering of its own — if it did, it would be
        // the second query path the do-not-touch doc forbids. Proven by the
        // aggregation returning an event for a source the caller cannot see:
        // it comes straight through.
        const leaky = jest.fn(async () => ({
            events: [{ id: 'X:1:DUE', entityType: 'X', entityId: '1', title: 't', date: '2026-09-01' }],
            omittedSources: ['incidents'],
            erroredSources: [],
        })) as never;
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => withoutDomain(ctxFor(), 'incidents'), aggregate: leaky, now: () => NOW },
        );
        expect(out.kind).toBe('generated');
        if (out.kind !== 'generated') throw new Error('unreachable');
        expect(out.events).toHaveLength(1);
    });
});

describe('a non-ACTIVE member is REFUSED, not given an empty set', () => {
    it('refuses when resolveMemberContext returns null', async () => {
        // null is a refusal. Falling back to a system context would push a
        // removed member's deadlines into their personal calendar under full
        // authority — the escalation that function exists to prevent.
        const aggregate = jest.fn();
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => null, aggregate: aggregate as never, now: () => NOW },
        );
        expect(out).toEqual({ kind: 'refused', reason: 'not-an-active-member' });
        // And it never even ran the aggregation.
        expect(aggregate).not.toHaveBeenCalled();
    });
});

describe('"nothing visible" is distinguished from "nothing due"', () => {
    it('a fully-demoted user reports no-visible-sources, NOT an empty generation', async () => {
        // The aggregation guards its all-sources-failed throw on
        // `eligible.length > 0`, so zero eligible sources yields events: [] and
        // every name in omittedSources — indistinguishable from a quiet week
        // unless the caller is told. The difference decides whether the push
        // job pushes nothing or DELETES EVERYTHING.
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            {
                resolveContext: async () =>
                    withoutDomain(withoutDomain(ctxFor(), 'incidents'), 'tasks'),
                aggregate: fakeAggregate,
                now: () => NOW,
            },
        );
        expect(out.kind).toBe('no-visible-sources');
    });

    it('an EMPTY WINDOW with sources visible is a normal generation', async () => {
        // The other half. Nothing due must not read as nothing visible, or a
        // quiet week wipes the user's calendar.
        const empty = jest.fn(async () => ({ events: [], omittedSources: [], erroredSources: [] })) as never;
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: empty, now: () => NOW },
        );
        expect(out.kind).toBe('generated');
    });

    it('an ERRORED source is NOT treated as a lost permission', async () => {
        // A database being briefly slow must not delete a user's whole
        // calendar. An errored source was attempted, so it was visible.
        const errored = jest.fn(async () => ({
            events: [], omittedSources: ['tasks'], erroredSources: ['incidents'],
        })) as never;
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: errored, now: () => NOW },
        );
        expect(out.kind).toBe('generated');
    });
});

describe('the context handed to the aggregation', () => {
    it('is the MEMBER’s, resolved live', async () => {
        const resolveContext = jest.fn(async () => ctxFor());
        await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext, aggregate: fakeAggregate, now: () => NOW },
        );
        expect(resolveContext).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't1', userId: 'u1', job: 'calendar-push' }),
        );
        expect(fakeAggregate.mock.calls[0][0]).toMatchObject({ userId: 'u1', tenantId: 't1' });
    });

    it('carries actorType JOB — resolveMemberContext does not set it', async () => {
        // Left unset, every audit row this generation produces claims the
        // PERSON acted, at 04:00, from a job they did not run.
        await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: fakeAggregate, now: () => NOW },
        );
        expect(fakeAggregate.mock.calls[0][0]).toMatchObject({ actorType: 'JOB' });
    });

    it('asks for a bounded forward window, not everything', async () => {
        await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: fakeAggregate, now: () => NOW },
        );
        const input = fakeAggregate.mock.calls[0][1] as unknown as { from: Date; to: Date };
        expect(input.from).toEqual(NOW);
        const days = (input.to.getTime() - input.from.getTime()) / 86_400_000;
        expect(days).toBe(PUSH_WINDOW_DAYS);
    });
});

describe('the mapping onto pushable events', () => {
    it('keys on entityType/entityId, not the composite event id', async () => {
        // The composite id embeds the event TYPE, so a due-date event becoming
        // an overdue event would change identity — orphaning the calendar entry
        // and creating a second one instead of patching the first.
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: fakeAggregate, now: () => NOW },
        );
        if (out.kind !== 'generated') throw new Error('unreachable');
        expect(out.events[0]).toMatchObject({ sourceKey: 'INCIDENT_NOTIFICATION', sourceEntityId: 'inc-1' });
        expect(JSON.stringify(out.events)).not.toContain(':DUE');
    });

    it('carries title, start and detail through', async () => {
        const out = await generatePushableEvents(
            { tenantId: 't1', userId: 'u1' },
            { resolveContext: async () => ctxFor(), aggregate: fakeAggregate, now: () => NOW },
        );
        if (out.kind !== 'generated') throw new Error('unreachable');
        expect(out.events[0]).toMatchObject({
            title: 'NIS2 notification due',
            startsAt: '2026-09-01T00:00:00.000Z',
            description: 'assigned to you',
        });
    });
});
