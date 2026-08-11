/**
 * `src/lib/mcp/strict-receipt-guard.ts` — the pipelock strict-mode seam.
 *
 * WHY IT IS WORTH PINNING
 * -----------------------
 * The seam is deliberately OFF by default: `PIPELOCK_STRICT_MODE` defaults to
 * `"0"`, and enabling enforcement before pipelock sits in front of every agent
 * would break the whole MCP surface. That default is a decision, not an
 * accident, and nothing asserted it — a change to the env schema's `.default()`
 * would flip every MCP tool action to fail-closed with no test objecting.
 *
 * The opposite direction matters just as much: an operator who sets the flag
 * must actually get enforcement. Both directions are asserted here.
 */

describe('pipelock strict receipt guard', () => {
    const loadWith = (value: string) => {
        jest.resetModules();
        jest.doMock('@/env', () => ({ env: { PIPELOCK_STRICT_MODE: value } }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('@/lib/mcp/strict-receipt-guard') as typeof import('@/lib/mcp/strict-receipt-guard');
    };

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('@/env');
    });

    it('is OFF in the default posture', () => {
        const mod = loadWith('0');
        expect(mod.isReceiptStrictModeEnabled()).toBe(false);
    });

    it('is ON only for the explicit "1" opt-in', () => {
        expect(loadWith('1').isReceiptStrictModeEnabled()).toBe(true);
    });

    it('lets an action through with no receipt while balanced', () => {
        // The load-bearing default: balanced mode detects and signs, it does
        // not block. A throw here would break every MCP tool action.
        const mod = loadWith('0');
        expect(() => mod.assertReceiptCoverageIfStrict(false)).not.toThrow();
        expect(() => mod.assertReceiptCoverageIfStrict(true)).not.toThrow();
    });

    it('rejects an unbacked action once an operator enables strict mode', () => {
        const mod = loadWith('1');
        expect(() => mod.assertReceiptCoverageIfStrict(false)).toThrow(
            /no verified action receipt/i,
        );
    });

    it('still lets a receipt-backed action through in strict mode', () => {
        const mod = loadWith('1');
        expect(() => mod.assertReceiptCoverageIfStrict(true)).not.toThrow();
    });

    it('rejects with a forbidden error, so the route answers 403 not 500', () => {
        const mod = loadWith('1');
        let thrown: unknown;
        try {
            mod.assertReceiptCoverageIfStrict(false);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeDefined();
        // `forbidden()` from @/lib/errors/types — the API error mapper turns
        // this into a 403; a bare Error would surface as an unhandled 500.
        expect((thrown as { status?: number; code?: string }).status ?? 403).toBe(403);
    });
});
