/**
 * A conflict cannot be resolved without a trace.
 *
 * A conflict is two systems of record disagreeing about one entity, and
 * resolving it means DISCARDING one side's value. In a product whose audit
 * trail is hash-chained specifically because divergence matters, that must not
 * be able to happen quietly.
 *
 * IT COULD. The only trace was `logEvent(...)` → `this.logger`, which defaults
 * to `noopSyncLogger`. An orchestrator constructed without an explicit logger
 * discarded every conflict; the two wired callers pass one only because
 * somebody remembered. A signal switched off by FORGETTING to switch it on is
 * not a signal — and here the thing it is meant to surface is invisibility.
 *
 * So the assertions below are mostly "it still records when nobody asked it
 * to", which is the property that was missing.
 */
const recordSyncConflict = jest.fn();
// Spread the real module and override only what this file asserts on. A factory
// that LISTS the functions is a snapshot of the module as it looked the day it
// was written: the next counter added upstream is `undefined` here, and calling
// undefined throws out of a caller contracted never to throw — so the red lands
// on an unrelated assertion in another file. The spread tracks the module by
// itself, and the exports nobody overrides stay real (a noop meter, no cost).
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncConflict: (...a: unknown[]) => recordSyncConflict(...a),
}));

import { BaseSyncOrchestrator } from '@/app-layer/integrations/sync-orchestrator';
import type { ConflictDetails } from '@/app-layer/integrations/sync-types';

/**
 * Minimal concrete orchestrator — only `resolveConflict` is under test, and it
 * touches no client, mapper or store. The abstract members throw rather than
 * returning a stub so a future test that strays into the sync paths fails
 * loudly here instead of asserting against an empty fake.
 */
class TestOrchestrator extends BaseSyncOrchestrator {
    protected resolveClient(): never { throw new Error('not used'); }
    protected resolveMapper(): never { throw new Error('not used'); }
    protected async applyLocalChanges(): Promise<string[]> { throw new Error('not used'); }
    protected async getLocalData(): Promise<never> { throw new Error('not used'); }
    protected extractRemoteId(): string | null { throw new Error('not used'); }
    protected extractRemoteData(): never { throw new Error('not used'); }
}

const details = (strategy: ConflictDetails['strategy']): ConflictDetails => ({
    strategy,
    reason: 'local and remote both changed',
    localData: { title: 'ours' },
    remoteData: { short_description: 'theirs' },
    lastSyncedRemoteData: { short_description: 'original' },
    conflictingFields: ['title'],
});

function make(withLogger: boolean) {
    return new TestOrchestrator({
        provider: 'servicenow',
        store: {} as never,
        ...(withLogger ? { logger: { log: jest.fn() } } : {}),
    } as never);
}

beforeEach(() => jest.clearAllMocks());

describe('every resolution is recorded', () => {
    it.each([
        ['REMOTE_WINS', 'remote_wins'],
        ['LOCAL_WINS', 'local_wins'],
        ['MANUAL', 'manual'],
    ] as const)('%s resolves to %s and emits the counter', (strategy, expected) => {
        const o = make(true);
        expect(o.resolveConflict(details(strategy))).toBe(expected);
        expect(recordSyncConflict).toHaveBeenCalledWith({
            provider: 'servicenow',
            direction: 'PUSH',
            resolution: expected,
        });
    });

    it('records even when NO logger was injected — the case that was silent', () => {
        // The whole point. Without this the default noopSyncLogger swallows the
        // conflict and the resolution leaves no trace anywhere.
        const o = make(false);
        o.resolveConflict(details('REMOTE_WINS'));
        expect(recordSyncConflict).toHaveBeenCalledTimes(1);
    });

    it('an unrecognised strategy still records, rather than resolving in silence', () => {
        // Defaults to remote_wins, matching the column default. A bad value
        // should show up as a rate, not as an absence.
        const o = make(true);
        expect(o.resolveConflict(details('NOT_A_STRATEGY' as never))).toBe('remote_wins');
        expect(recordSyncConflict).toHaveBeenCalledWith(
            expect.objectContaining({ resolution: 'remote_wins' }),
        );
    });
});

describe('direction is carried, because the two mean different things', () => {
    it('defaults to PUSH but takes PULL when told', () => {
        const o = make(true);
        o.resolveConflict(details('LOCAL_WINS'), 'PULL');
        expect(recordSyncConflict).toHaveBeenCalledWith(
            expect.objectContaining({ direction: 'PULL', resolution: 'local_wins' }),
        );
    });

    it('local_wins on a PULL discards the REMOTE value; on a PUSH it overwrites it', () => {
        // Same resolution, opposite consequence — which is why the label exists
        // and why a single undirected conflict count would be unreadable.
        const o = make(true);
        o.resolveConflict(details('LOCAL_WINS'), 'PULL');
        o.resolveConflict(details('LOCAL_WINS'), 'PUSH');
        const directions = recordSyncConflict.mock.calls.map((c) => c[0].direction);
        expect(directions).toEqual(['PULL', 'PUSH']);
    });
});

describe('the counter labels stay bounded', () => {
    it('carries no mapping id, entity id, or field names', () => {
        // A counter label is a metric series. Putting an entity id on one is
        // how an observability change becomes the outage — the same trap
        // providerLabelFor exists to avoid. The structured log carries those;
        // they answer different questions.
        const o = make(true);
        o.resolveConflict(details('MANUAL'));
        const attrs = recordSyncConflict.mock.calls[0][0];
        expect(Object.keys(attrs).sort()).toEqual(['direction', 'provider', 'resolution']);
    });
});
