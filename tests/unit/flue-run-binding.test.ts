/**
 * A RUN'S AUTHORITY IS CLAIMED ONCE AND THEN GONE.
 *
 * The runtime fixes its agent set at boot and refuses an async agent function,
 * so everything a run's agent needs must be resolved before dispatch and read
 * synchronously during it. `initialData` is the runtime's own channel for that
 * and is explicitly "not a secrets channel" — it is part of the durable record
 * stream — so the run id travels there and the invocation, which carries the
 * tenant, the principal and the key id, stays in this process addressed by it.
 *
 * That makes this map an authority lookup, which is why it takes rather than
 * gets, and refuses to rebind.
 */
import {
    bindRun,
    takeRunBinding,
    releaseRun,
    outstandingRunBindings,
    type FlueRunBinding,
} from '@/lib/agentic/flue/run-binding';

const binding = (marker: string): FlueRunBinding => ({
    tools: [{ name: marker } as FlueRunBinding['tools'][number]],
    modelSpecifier: 'inflect-local/llama-3.1-70b',
});

afterEach(() => {
    for (const id of ['r1', 'r2', 'r3']) releaseRun(id);
});

describe('binding a run', () => {
    it('hands back exactly what was bound', () => {
        bindRun('r1', binding('t1'));
        expect(takeRunBinding('r1')?.modelSpecifier).toBe('inflect-local/llama-3.1-70b');
    });

    it('REFUSES a second bind for a live run', () => {
        // Two callers believing they own one run is the case where silently
        // keeping the newer authority picks the wrong one. Being told is the
        // whole point.
        bindRun('r1', binding('t1'));
        expect(() => bindRun('r1', binding('t2'))).toThrow(/already bound/);
    });

    it('the refusal does not corrupt the binding that was already there', () => {
        // A throw that half-applied would be worse than the overwrite it is
        // preventing.
        bindRun('r1', binding('tenant-one'));
        expect(() => bindRun('r1', binding('tenant-two'))).toThrow();
        const claimed = takeRunBinding('r1');
        expect(claimed?.tools[0]?.name).toBe('tenant-one');
    });
});

describe('claiming a run', () => {
    it('TAKES — a second claim finds nothing', () => {
        // The assertion with teeth. A `get` would leave authority addressable
        // after the run that resolved it has finished with it.
        bindRun('r1', binding('t1'));
        expect(takeRunBinding('r1')).toBeDefined();
        expect(takeRunBinding('r1')).toBeUndefined();
    });

    it('an unbound run claims nothing rather than throwing', () => {
        // The agent function is synchronous and has no error channel worth
        // using; absence is a state its caller decides about.
        expect(takeRunBinding('never-bound')).toBeUndefined();
    });

    it('binds are independent — claiming one leaves the others', () => {
        bindRun('r1', binding('t1'));
        bindRun('r2', binding('t2'));
        takeRunBinding('r1');
        expect(takeRunBinding('r2')).toBeDefined();
    });
});

describe('the map does not grow without bound', () => {
    it('a claimed run leaves nothing behind', () => {
        const before = outstandingRunBindings();
        bindRun('r1', binding('t1'));
        takeRunBinding('r1');
        expect(outstandingRunBindings()).toBe(before);
    });

    it('a run that is bound and never dispatched can be released', () => {
        // The failure path between bind and dispatch: a refused start, a throw.
        // Without release, that authority sits in the map for the lifetime of
        // the process — a leak in a worker, and a stale answer if the id ever
        // recurs.
        const before = outstandingRunBindings();
        bindRun('r3', binding('t3'));
        expect(outstandingRunBindings()).toBe(before + 1);
        releaseRun('r3');
        expect(outstandingRunBindings()).toBe(before);
    });

    it('releasing an unbound run is a no-op, not an error', () => {
        const before = outstandingRunBindings();
        releaseRun('never-bound');
        expect(outstandingRunBindings()).toBe(before);
    });
});
