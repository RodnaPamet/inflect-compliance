/**
 * The concurrent-stream caps, across tenants (#3831).
 *
 * The per-tenant cap and "refuses the N+1 without degrading the open ones" are
 * asserted in `tests/unit/ai/assistant-stream-transport.test.ts`, through the
 * route. What that cannot reach is the part that needs more than one tenant:
 *
 *   · one tenant filling its own allowance does not deny another;
 *   · the GLOBAL cap binds even when no single tenant is at its limit;
 *   · a released slot is actually reusable, and released only once.
 *
 * The last one is the quiet failure. A double-release decrements the counter
 * twice, so capacity drifts UPWARD and the process eventually admits more
 * streams than the cap allows — the cap stops binding without ever erroring.
 */
import {
    acquireStreamSlot,
    streamCapacitySnapshot,
    __resetStreamCapacity,
    MAX_STREAMS_PER_TENANT,
    MAX_STREAMS_GLOBAL,
    type CapacityLease,
} from '@/app-layer/ai/assistant/stream-capacity';

const isLease = (v: CapacityLease | string): v is CapacityLease => typeof v !== 'string';

beforeEach(() => {
    __resetStreamCapacity();
});

describe('one tenant cannot deny another', () => {
    it('a tenant at its own cap leaves other tenants unaffected', async () => {
        const held: CapacityLease[] = [];
        for (let i = 0; i < MAX_STREAMS_PER_TENANT; i += 1) {
            const lease = acquireStreamSlot('tenant-a');
            if (isLease(lease)) held.push(lease);
        }
        expect(held).toHaveLength(MAX_STREAMS_PER_TENANT);

        // A is full…
        expect(acquireStreamSlot('tenant-a')).toBe('TENANT_AT_CAPACITY');
        // …and B is untouched. Without a per-tenant term, one noisy customer
        // would fill the process and every other tenant would see refusals they
        // did nothing to cause.
        expect(isLease(acquireStreamSlot('tenant-b'))).toBe(true);
    });

    it('releasing one tenant slot does not release another tenant', () => {
        const a = acquireStreamSlot('tenant-a');
        const b = acquireStreamSlot('tenant-b');
        if (!isLease(a) || !isLease(b)) throw new Error('expected both to be admitted');

        a.release();

        const snap = streamCapacitySnapshot();
        expect(snap.tenants['tenant-a']).toBeUndefined();
        expect(snap.tenants['tenant-b']).toBe(1);
        expect(snap.total).toBe(1);
    });
});

describe('the GLOBAL cap binds even with every tenant under its own limit', () => {
    it('refuses with PROCESS_AT_CAPACITY, naming the term that is actually binding', () => {
        // Enough distinct tenants that no single one reaches its per-tenant cap,
        // so only the global term can refuse. A refusal naming the wrong term
        // sends an operator to the wrong setting — the same argument
        // `assertAutonomy` makes about its own refusals.
        const tenants = Math.ceil(MAX_STREAMS_GLOBAL / (MAX_STREAMS_PER_TENANT - 1));
        const held: CapacityLease[] = [];
        outer: for (let t = 0; t < tenants + 2; t += 1) {
            for (let i = 0; i < MAX_STREAMS_PER_TENANT - 1; i += 1) {
                const lease = acquireStreamSlot(`tenant-${t}`);
                if (!isLease(lease)) {
                    expect(lease).toBe('PROCESS_AT_CAPACITY');
                    break outer;
                }
                held.push(lease);
            }
        }

        expect(held).toHaveLength(MAX_STREAMS_GLOBAL);
        expect(streamCapacitySnapshot().total).toBe(MAX_STREAMS_GLOBAL);

        // And every tenant involved is strictly under its own cap, so the
        // assertion above is about the global term rather than a per-tenant one
        // reached by accident.
        for (const count of Object.values(streamCapacitySnapshot().tenants)) {
            expect(count).toBeLessThan(MAX_STREAMS_PER_TENANT);
        }
    });

    it('frees a global slot when one is released, and it is reusable', () => {
        const held: CapacityLease[] = [];
        for (let i = 0; i < MAX_STREAMS_GLOBAL; i += 1) {
            const lease = acquireStreamSlot(`t-${i}`);
            if (isLease(lease)) held.push(lease);
        }
        expect(acquireStreamSlot('newcomer')).toBe('PROCESS_AT_CAPACITY');

        held[0].release();

        // Reusable, not merely counted down: a cap that frees a number but not a
        // slot would refuse forever while reporting capacity.
        expect(isLease(acquireStreamSlot('newcomer'))).toBe(true);
    });
});

describe('a slot is released exactly once', () => {
    it('a double release does not free capacity twice', () => {
        // THE QUIET FAILURE. The route releases on a client abort AND on stream
        // completion, and both can fire for one turn. A double-decrement makes
        // the counter drift upward, so the process gradually admits more streams
        // than the cap allows — the cap stops binding and nothing ever errors.
        const lease = acquireStreamSlot('tenant-a');
        if (!isLease(lease)) throw new Error('expected admission');
        expect(streamCapacitySnapshot().total).toBe(1);

        lease.release();
        lease.release();
        lease.release();

        expect(streamCapacitySnapshot().total).toBe(0);
        // Not negative, which is how the drift would show up first.
        expect(streamCapacitySnapshot().total).toBeGreaterThanOrEqual(0);
        expect(streamCapacitySnapshot().tenants).toEqual({});
    });

    it('and the cap still binds after a churn of acquire/release cycles', () => {
        // The drift is cumulative, so one cycle would not reveal it. Many do.
        for (let i = 0; i < MAX_STREAMS_GLOBAL * 3; i += 1) {
            const lease = acquireStreamSlot('tenant-churn');
            if (isLease(lease)) {
                lease.release();
                lease.release();
            }
        }

        expect(streamCapacitySnapshot().total).toBe(0);

        const held: CapacityLease[] = [];
        for (let i = 0; i < MAX_STREAMS_PER_TENANT + 1; i += 1) {
            const lease = acquireStreamSlot('tenant-after');
            if (isLease(lease)) held.push(lease);
        }
        // Exactly the cap, not more — which it would be if the churn had leaked.
        expect(held).toHaveLength(MAX_STREAMS_PER_TENANT);
    });
});
