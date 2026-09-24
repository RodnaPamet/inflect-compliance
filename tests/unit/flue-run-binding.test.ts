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
    readRunBinding,
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
        expect(readRunBinding('r1')?.modelSpecifier).toBe('inflect-local/llama-3.1-70b');
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
        const claimed = readRunBinding('r1');
        expect(claimed?.tools[0]?.name).toBe('tenant-one');
    });
});

describe('reading a run', () => {
    it('READS — every render sees the same authority', () => {
        // THE ASSERTION WITH TEETH, and it used to say the opposite. A
        // destructive read gave the FIRST render the tools and every later one
        // the no-authority branch, because `@flue/runtime` re-runs the agent
        // function before every model call. A two-turn run was a one-turn run
        // with a blind tail that still reported COMPLETED.
        bindRun('r1', binding('t1'));
        expect(readRunBinding('r1')).toBeDefined();
        expect(readRunBinding('r1')).toBeDefined();
        expect(readRunBinding('r1')?.tools[0]?.name).toBe('t1');
    });

    it('an unbound run reads nothing rather than throwing', () => {
        // The agent function is synchronous and has no error channel worth
        // using; absence is a state its caller decides about.
        expect(readRunBinding('never-bound')).toBeUndefined();
    });

    it('binds are independent — reading one does not disturb the others', () => {
        bindRun('r1', binding('t1'));
        bindRun('r2', binding('t2'));
        readRunBinding('r1');
        expect(readRunBinding('r2')?.tools[0]?.name).toBe('t2');
    });

    it('release is what ends a binding, and it is final', () => {
        // Disposal moved to the driver's `finally`. Reading must not dispose;
        // releasing must.
        bindRun('r1', binding('t1'));
        readRunBinding('r1');
        releaseRun('r1');
        expect(readRunBinding('r1')).toBeUndefined();
    });
});

describe('the map does not grow without bound', () => {
    it('a released run leaves nothing behind', () => {
        // The leak property survives the move from take to read, because the
        // driver's `finally` releases on EVERY exit. What changed is who
        // disposes, not whether anyone does.
        const before = outstandingRunBindings();
        bindRun('r1', binding('t1'));
        readRunBinding('r1');
        expect(outstandingRunBindings()).toBe(before + 1); // a read keeps it
        releaseRun('r1');
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
