/**
 * The process canvas module switch.
 *
 * The three properties worth pinning are the default, the no-op, and the audit
 * — in that order of consequence.
 *
 * The default used to be described here as a LICENCE control, on the grounds
 * that "the editor behind this surface may not be put in front of customers".
 * That was the tldraw 4.x/5.x licence, and #2988 pinned 3.15.6, which permits
 * commercial use with the watermark and needs no key (#2958). The default stays
 * OFF because a module nobody asked for should not appear, and because the
 * bundle control in `canvas-editor-stays-inside-its-module` depends on tenants
 * with the module off never loading the route — not because ON is a violation.
 */
/*
    ATOMICITY IS ASSERTED BY SHAPE, because a mock has no transactions (#3175).

    `runInTenantContext` is a `$transaction`, and this mock is a pass-through:
    nothing here can roll anything back, so no assertion about outcomes can
    distinguish "both writes in one transaction" from "two transactions, the
    first already committed". That difference is exactly the defect — the upsert
    committed, the audit write threw, the route returned 400, and the UI told the
    owner nothing had changed while production carried the change.

    So the harness records, per `runInTenantContext` call, WHICH writes ran inside
    it. One transaction containing both names is the property; the same two writes
    across two transactions is the bug, and the two are indistinguishable by call
    order alone. Same reasoning as `org-tenant-delete.test.ts` asserting
    `txnBatchSizes` rather than the sequence of calls.
*/
const transactions: string[][] = [];
let openTx: string[] | null = null;
const inTx = (label: string) => {
    if (openTx) openTx.push(label);
    else transactions.push([`OUTSIDE-ANY-TRANSACTION:${label}`]);
};

const db = {
    tenantSecuritySettings: {
        findUnique: jest.fn(async () => { inTx('findUnique'); return null as unknown; }),
        upsert: jest.fn(async () => { inTx('upsert'); return {}; }),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_c: unknown, fn: (d: unknown) => unknown) => {
        const writes: string[] = [];
        const outer = openTx;
        openTx = writes;
        try {
            return await fn(db);
        } finally {
            openTx = outer;
            transactions.push(writes);
        }
    },
}));

const logEvent = jest.fn(async (..._args: unknown[]) => { inTx('logEvent'); return undefined; });
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

// Records whether each `logger.info` was emitted from INSIDE an open
// transaction. A line logged before commit claims a change a rollback would
// undo — the same error as the 400, pointing the other way.
const infoFromInsideTx: boolean[] = [];
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        trace: jest.fn(), debug: jest.fn(),
        info: jest.fn(() => { infoFromInsideTx.push(openTx !== null); }),
        warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
    },
}));

import {
    isProcessCanvasEnabled,
    setProcessCanvasEnabled,
} from '@/app-layer/usecases/process-canvas-module';
import { makeRequestContext } from '../helpers/make-context';
// The REAL validator, deliberately un-mocked — it is the contract the payload
// above has to satisfy, and mocking it would reproduce the gap (#3170).
import { validateAuditDetailsJson } from '@/app-layer/schemas/json-columns.schemas';

const ctx = makeRequestContext('OWNER');

/**
 * `findUnique` has to both RECORD that it ran inside the transaction and return
 * what each test wants. `mockResolvedValue` would replace the recording
 * implementation, so tests set the value through this instead.
 */
function settingsRow(value: { processCanvasEnabled?: boolean } | null) {
    db.tenantSecuritySettings.findUnique.mockImplementation(async () => {
        inTx('findUnique');
        return value as unknown;
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    transactions.length = 0;
    infoFromInsideTx.length = 0;
    openTx = null;
    db.tenantSecuritySettings.upsert.mockImplementation(async () => { inTx('upsert'); return {}; });
    logEvent.mockImplementation(async () => { inTx('logEvent'); return undefined; });
    settingsRow(null);
});

describe('the module defaults to OFF', () => {
    it('a tenant with NO settings row does not have the module', async () => {
        // "Nobody has configured this tenant" must not mean "give them the
        // surface". A default of ON would also make the bundle control moot on
        // day one: the editor stays out of shared chunks precisely so a tenant
        // with the module off never downloads it, and every tenant having it
        // on by default would leave nothing for that guard to protect.
        settingsRow(null);
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });

    it('a row that says false is false', async () => {
        settingsRow({ processCanvasEnabled: false });
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });

    it('and a row that says true IS true — the control that makes the above mean something', async () => {
        // Without this, a reader hard-coded to `false` would satisfy both
        // assertions above and no tenant would ever get the module.
        settingsRow({ processCanvasEnabled: true });
        expect(await isProcessCanvasEnabled(ctx)).toBe(true);
    });

    it('an undefined column reads as off, not as on', async () => {
        // A row present but the column absent — the shape a pre-migration row
        // has. `=== true` rather than truthiness is what makes this safe.
        settingsRow({});
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });
});

describe('turning the module on and off', () => {
    it('enabling writes the setting and audits it', async () => {
        settingsRow({ processCanvasEnabled: false });

        const r = await setProcessCanvasEnabled(ctx, true);

        expect(r).toEqual({ enabled: true, changed: true });
        expect(db.tenantSecuritySettings.upsert).toHaveBeenCalledTimes(1);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('the audit row says WHICH WAY it moved, not merely that it changed', async () => {
        // A row recording "the module changed" leaves a reviewer to go and look
        // up which direction — and the direction is the whole content of the
        // event, because one of them grants a surface and the other removes it.
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        const payload = logEvent.mock.calls[0]![2] as unknown as {
            action: string;
            detailsJson: {
                category: string;
                operation: string;
                fromStatus?: string;
                toStatus?: string;
            };
            metadata: { from: boolean; to: boolean };
        };
        expect(payload.action).toBe('PROCESS_CANVAS_MODULE_CHANGED');
        expect(payload.metadata).toEqual({ from: false, to: true });
        expect(payload.detailsJson.operation).toBe('enable');
        /*
            `status_change`, not `access` — the reasoning in the line this
            replaces still holds and is worth keeping: the identity ladder next
            door chose `access` because it grants the product authority over a
            customer's directory, and this grants nobody anything, it changes
            what the product offers.

            It chose `configuration` on that reasoning, which was sound about
            MEANING and never checked against the VOCABULARY —
            `AuditDetailsJsonSchema` has no such category, so every write threw
            a 400 and the module could not be enabled at all (#3170). The
            schema's own from/to fields say the same thing, in a value readers
            already understand.
        */
        expect(payload.detailsJson.category).toBe('status_change');
        expect(payload.detailsJson.fromStatus).toBe('off');
        expect(payload.detailsJson.toStatus).toBe('on');
    });

    it('disabling audits the other direction', async () => {
        settingsRow({ processCanvasEnabled: true });

        const r = await setProcessCanvasEnabled(ctx, false);

        expect(r).toEqual({ enabled: false, changed: true });
        const payload = logEvent.mock.calls[0]![2] as unknown as {
            detailsJson: { operation: string };
            metadata: { from: boolean; to: boolean };
        };
        expect(payload.metadata).toEqual({ from: true, to: false });
        expect(payload.detailsJson.operation).toBe('disable');
    });

    it('setting it to the value it already has writes nothing and audits nothing', async () => {
        // A no-op is not an event. Rows recording that nothing happened make
        // the rows that DO record something harder to find.
        settingsRow({ processCanvasEnabled: true });

        const r = await setProcessCanvasEnabled(ctx, true);

        expect(r).toEqual({ enabled: true, changed: false });
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('the no-op check does not swallow a REAL change — the control for it', async () => {
        // The assertion above passes for a function that never writes at all.
        settingsRow({ processCanvasEnabled: false });
        await setProcessCanvasEnabled(ctx, true);
        expect(db.tenantSecuritySettings.upsert).toHaveBeenCalledTimes(1);
    });
});

/**
 * The audit payload must satisfy the REAL schema (#3170).
 *
 * Every test above asserts on a MOCKED `logEvent`, so the payload was never
 * validated — and `category: 'configuration'` sat there passing them all while
 * `validateAuditDetailsJson` rejected it in production, 400'ing the request and
 * rolling the upsert back with it. The module could not be turned on at any
 * point in its life, and nine assertions were green over it.
 *
 * Mocking the audit layer is right for the tests above: they are about WHAT is
 * recorded, not about the writer. The gap is that nothing then checked the
 * recorded shape against the contract it has to satisfy. This closes it without
 * un-mocking anything.
 */
describe('the audit payload satisfies AuditDetailsJsonSchema', () => {
    it('enabling produces a payload the real validator accepts', async () => {
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        const payload = logEvent.mock.calls[0]![2] as unknown as { detailsJson: unknown };
        expect(() => validateAuditDetailsJson(payload.detailsJson)).not.toThrow();
    });

    it('and so does disabling', async () => {
        settingsRow({ processCanvasEnabled: true });

        await setProcessCanvasEnabled(ctx, false);

        const payload = logEvent.mock.calls[0]![2] as unknown as { detailsJson: unknown };
        expect(() => validateAuditDetailsJson(payload.detailsJson)).not.toThrow();
    });

    it('and the validator really does reject the old value — the control', () => {
        /*
            Teeth. Without this, a validator that accepted anything would make
            both assertions above pass while proving nothing — which is the
            exact failure mode that let the original defect through.
        */
        expect(() =>
            validateAuditDetailsJson({ category: 'configuration', operation: 'enable' }),
        ).toThrow(/Invalid detailsJson structure/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// #3175 — the flag and the row recording it commit together
// ═════════════════════════════════════════════════════════════════════

describe('the write and its audit row are one transaction', () => {
    /**
     * THE REGRESSION, and it is not hypothetical: it shipped. The upsert and the
     * audit write were two `runInTenantContext` calls, so two transactions. On
     * 2026-10-03 the audit write threw on an invalid category, the route
     * returned 400, the UI said the setting had not changed — and production's
     * `TenantSecuritySettings.updatedAt` is that minute, with the module on ever
     * since.
     *
     * Splitting them again produces two entries here, one write in each, and
     * fails. Call order cannot tell those two worlds apart, which is why this
     * asserts the grouping instead.
     */
    it('enabling opens exactly ONE transaction, holding the read, the write and the audit row', async () => {
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toEqual(['findUnique', 'upsert', 'logEvent']);
    });

    it('disabling does the same', async () => {
        settingsRow({ processCanvasEnabled: true });

        await setProcessCanvasEnabled(ctx, false);

        expect(transactions).toHaveLength(1);
        expect(transactions[0]).toEqual(['findUnique', 'upsert', 'logEvent']);
    });

    /**
     * The harness labels any write reaching the client with no transaction open
     * as `OUTSIDE-ANY-TRANSACTION:…`, so this fails loudly rather than by a
     * count that happens to match.
     */
    it('nothing touches the database outside a transaction', async () => {
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        expect(transactions.flat().filter(w => w.startsWith('OUTSIDE'))).toEqual([]);
    });

    /**
     * `current` becomes the audit row's `fromStatus`. Read in an earlier
     * transaction it can already be stale, and two admins toggling at once would
     * write two rows describing transitions from a baseline only one of them
     * left. The read belongs in the same transaction as the row that quotes it.
     */
    it('the baseline the audit row quotes is read inside that same transaction', async () => {
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        expect(transactions[0][0]).toBe('findUnique');
        expect(transactions[0].indexOf('findUnique'))
            .toBeLessThan(transactions[0].indexOf('logEvent'));
        const payload = (logEvent.mock.calls[0] as unknown[])[2] as {
            detailsJson: { fromStatus: string; toStatus: string };
        };
        expect(payload.detailsJson).toMatchObject({ fromStatus: 'off', toStatus: 'on' });
    });

    it('the no-op path opens one transaction for the read and writes nothing in it', async () => {
        settingsRow({ processCanvasEnabled: true });

        const r = await setProcessCanvasEnabled(ctx, true);

        expect(r).toEqual({ enabled: true, changed: false });
        expect(transactions).toEqual([['findUnique']]);
        expect(logEvent).not.toHaveBeenCalled();
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it('the success line is logged AFTER the commit, never from inside it', async () => {
        settingsRow({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        expect(infoFromInsideTx).toEqual([false]);
    });

    it('and a no-op logs no success line at all — the control', async () => {
        // Without this, moving the log outside the transaction could also mean
        // logging it unconditionally, which reports a change on every PUT.
        settingsRow({ processCanvasEnabled: true });

        await setProcessCanvasEnabled(ctx, true);

        expect(infoFromInsideTx).toEqual([]);
    });
});
