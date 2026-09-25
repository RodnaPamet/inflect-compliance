/**
 * The helper that makes a subset mock fail at the omission (#2897).
 *
 * Every assertion here is about the SHAPE of the failure, not about any
 * particular module: the point of the helper is that a missing export stops
 * being an `undefined` that surfaces elsewhere.
 */
import { strictMock } from '../helpers/strict-mock';

const actual = {
    logEvent: () => 'real logEvent',
    appendAuditEntryOrQueue: () => 'real wrapper',
    verifyAuditChain: () => 'real verify',
};

describe('strictMock', () => {
    it('returns what the factory supplied', () => {
        const m = strictMock('@/lib/audit', actual, { logEvent: () => 'stub' });
        expect(m.logEvent()).toBe('stub');
    });

    it('throws when the code reaches for an export the factory omitted', () => {
        const m = strictMock('@/lib/audit', actual, { logEvent: () => 'stub' });
        expect(() => m.appendAuditEntryOrQueue()).toThrow(/omits 'appendAuditEntryOrQueue'/);
    });

    it('names the module, so the error says which fixture to fix', () => {
        const m = strictMock('@/lib/audit', actual, {});
        expect(() => m.verifyAuditChain()).toThrow(/@\/lib\/audit/);
    });

    it('stays silent for a key the real module does not have either', () => {
        // Not the helper's business. A genuinely unknown property is undefined
        // in the real module too, and throwing would make this stricter than
        // the thing it is standing in for.
        const m = strictMock('@/lib/audit', actual, {}) as unknown as Record<string, unknown>;
        expect(m.somethingNobodyExports).toBeUndefined();
    });

    it('answers the interop probes quietly', () => {
        // The load-bearing case. `__esModule`, `then` and `default` are read by
        // the ESM interop on every import — before any test body runs. A throw
        // here fails the import itself, and the error would name the interop
        // rather than the omission it exists to report.
        const m = strictMock('@/lib/audit', actual, { logEvent: () => 'stub' }) as unknown as Record<
            string,
            unknown
        >;
        expect(() => m.__esModule).not.toThrow();
        expect(() => m.then).not.toThrow();
        expect(() => m.default).not.toThrow();
    });

    it('does not throw on a symbol lookup', () => {
        // `await`, spread and stringification all probe symbols.
        const m = strictMock('@/lib/audit', actual, {});
        expect(() => String(m)).not.toThrow();
        expect(() => ({ ...m })).not.toThrow();
    });

    it('reports membership from the REAL module, not just the factory', () => {
        // So a caller testing `'x' in mod` sees the module's true shape rather
        // than the fixture's, which is what makes the throw meaningful.
        const m = strictMock('@/lib/audit', actual, { logEvent: () => 'stub' });
        expect('appendAuditEntryOrQueue' in m).toBe(true);
        expect('neverExported' in m).toBe(false);
    });
});
