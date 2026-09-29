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
const db = {
    tenantSecuritySettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(async () => ({})),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (d: unknown) => unknown) => fn(db),
}));

const logEvent = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        trace: jest.fn(), debug: jest.fn(), info: jest.fn(),
        warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
    },
}));

import {
    isProcessCanvasEnabled,
    isProcessCanvasTldrawEnabled,
    setProcessCanvasEnabled,
    setProcessCanvasTldraw,
} from '@/app-layer/usecases/process-canvas-module';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER');

beforeEach(() => {
    jest.clearAllMocks();
    db.tenantSecuritySettings.upsert.mockResolvedValue({});
});

describe('the module defaults to OFF', () => {
    it('a tenant with NO settings row does not have the module', async () => {
        // "Nobody has configured this tenant" must not mean "give them the
        // surface". A default of ON would also make the bundle control moot on
        // day one: the editor stays out of shared chunks precisely so a tenant
        // with the module off never downloads it, and every tenant having it
        // on by default would leave nothing for that guard to protect.
        db.tenantSecuritySettings.findUnique.mockResolvedValue(null);
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });

    it('a row that says false is false', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: false });
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });

    it('and a row that says true IS true — the control that makes the above mean something', async () => {
        // Without this, a reader hard-coded to `false` would satisfy both
        // assertions above and no tenant would ever get the module.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: true });
        expect(await isProcessCanvasEnabled(ctx)).toBe(true);
    });

    it('an undefined column reads as off, not as on', async () => {
        // A row present but the column absent — the shape a pre-migration row
        // has. `=== true` rather than truthiness is what makes this safe.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({});
        expect(await isProcessCanvasEnabled(ctx)).toBe(false);
    });
});

describe('turning the module on and off', () => {
    it('enabling writes the setting and audits it', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: false });

        const r = await setProcessCanvasEnabled(ctx, true);

        expect(r).toEqual({ enabled: true, changed: true });
        expect(db.tenantSecuritySettings.upsert).toHaveBeenCalledTimes(1);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('the audit row says WHICH WAY it moved, not merely that it changed', async () => {
        // A row recording "the module changed" leaves a reviewer to go and look
        // up which direction — and the direction is the whole content of the
        // event, because one of them grants a surface and the other removes it.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: false });

        await setProcessCanvasEnabled(ctx, true);

        const payload = logEvent.mock.calls[0]![2] as unknown as {
            action: string;
            detailsJson: { category: string; operation: string };
            metadata: { from: boolean; to: boolean };
        };
        expect(payload.action).toBe('PROCESS_CANVAS_MODULE_CHANGED');
        expect(payload.metadata).toEqual({ from: false, to: true });
        expect(payload.detailsJson.operation).toBe('enable');
        // `configuration`, not `access` — the identity ladder next door chose
        // `access` because it grants the product authority over a customer's
        // directory. This grants nobody anything; it changes what the product
        // offers.
        expect(payload.detailsJson.category).toBe('configuration');
    });

    it('disabling audits the other direction', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: true });

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
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: true });

        const r = await setProcessCanvasEnabled(ctx, true);

        expect(r).toEqual({ enabled: true, changed: false });
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('the no-op check does not swallow a REAL change — the control for it', async () => {
        // The assertion above passes for a function that never writes at all.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({ processCanvasEnabled: false });
        await setProcessCanvasEnabled(ctx, true);
        expect(db.tenantSecuritySettings.upsert).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────────────────────────────────────────────
//  #2960 — WHICH renderer, as distinct from WHETHER there is a canvas.
// ─────────────────────────────────────────────────────────────────────

describe('the renderer flag defaults to xyflow', () => {
    it('a tenant with NO settings row is on xyflow', async () => {
        // "Never configured" means "never migrated". The safe reading is the
        // renderer that is finished.
        db.tenantSecuritySettings.findUnique.mockResolvedValue(null);
        expect(await isProcessCanvasTldrawEnabled(ctx)).toBe(false);
    });

    it('a row that says false is xyflow', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasUsesTldraw: false,
        });
        expect(await isProcessCanvasTldrawEnabled(ctx)).toBe(false);
    });

    it('and a row that says true IS tldraw — the control that makes the above mean something', async () => {
        // Without this, a reader hard-coded to `false` would satisfy both
        // assertions above and no tenant could ever be migrated.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasUsesTldraw: true,
        });
        expect(await isProcessCanvasTldrawEnabled(ctx)).toBe(true);
    });

    it('reads its OWN column, not the module flag', async () => {
        // The two are independent. A row with the module on and the renderer
        // unset must not read as migrated — that would move every tenant who
        // ever enabled the canvas.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasEnabled: true,
            processCanvasUsesTldraw: false,
        });
        expect(await isProcessCanvasTldrawEnabled(ctx)).toBe(false);
    });
});

describe('switching renderer', () => {
    it('writes the column and audits the move', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasUsesTldraw: false,
        });
        const res = await setProcessCanvasTldraw(ctx, true);

        expect(res).toEqual({ usesTldraw: true, changed: true });
        expect(db.tenantSecuritySettings.upsert).toHaveBeenCalledTimes(1);
        expect(db.tenantSecuritySettings.upsert.mock.calls[0][0]).toMatchObject({
            create: { processCanvasUsesTldraw: true },
            update: { processCanvasUsesTldraw: true },
        });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const entry = logEvent.mock.calls[0][2] as Record<string, unknown>;
        expect(entry.action).toBe('PROCESS_CANVAS_RENDERER_CHANGED');
        // `configuration`, not `access`: this grants nobody any authority and
        // changes no permission check. It changes what the product draws.
        expect(entry.detailsJson).toMatchObject({ category: 'configuration' });
        expect(entry.metadata).toEqual({ from: false, to: true });
    });

    it('a no-op writes nothing and audits nothing', async () => {
        // Auditing "changed from xyflow to xyflow" puts rows in front of a
        // reviewer that record nothing happening, and makes the rows that DO
        // record something harder to find.
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasUsesTldraw: true,
        });
        const res = await setProcessCanvasTldraw(ctx, true);

        expect(res).toEqual({ usesTldraw: true, changed: false });
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('moves BACK, because a migration flag that only goes one way is a trapdoor', async () => {
        db.tenantSecuritySettings.findUnique.mockResolvedValue({
            processCanvasUsesTldraw: true,
        });
        const res = await setProcessCanvasTldraw(ctx, false);

        expect(res).toEqual({ usesTldraw: false, changed: true });
        expect(db.tenantSecuritySettings.upsert.mock.calls[0][0]).toMatchObject({
            update: { processCanvasUsesTldraw: false },
        });
        // Both renderers read the same ProcessNode / ProcessEdge rows, so
        // going back is a rendering decision with no data step.
        expect(
            (logEvent.mock.calls[0][2] as Record<string, unknown>).metadata,
        ).toEqual({ from: true, to: false });
    });
});
