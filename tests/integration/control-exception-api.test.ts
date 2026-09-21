/**
 * Epic G-5 — API contract tests for the control-scoped exception
 * surface + the control-detail wiring.
 *
 * Static / structural tests that prove:
 *   • Each route exists at the expected nested path
 *   • Each route delegates to the correct usecase
 *   • Each mutation route uses `withValidatedBody` with the right schema
 *   • The control-detail page mounts the panel + header badge
 */
import * as fs from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. The raw reader is kept and the JSON path still uses it: a
// catalogue is PARSED as data, never matched as text, so masking it would only
// corrupt the parse. Text assertions go through the masked reader.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
function readRaw(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function read(rel: string): string {
    return codeOf(readRaw(rel));
}

describe('Epic G-5 — control exception API + UI wiring', () => {
    const listRoute = read(
        'src/app/api/t/[tenantSlug]/controls/[controlId]/exceptions/route.ts',
    );
    const detailRoute = read(
        'src/app/api/t/[tenantSlug]/controls/[controlId]/exceptions/[exceptionId]/route.ts',
    );
    const approveRoute = read(
        'src/app/api/t/[tenantSlug]/controls/[controlId]/exceptions/[exceptionId]/approve/route.ts',
    );
    const rejectRoute = read(
        'src/app/api/t/[tenantSlug]/controls/[controlId]/exceptions/[exceptionId]/reject/route.ts',
    );
    const renewRoute = read(
        'src/app/api/t/[tenantSlug]/controls/[controlId]/exceptions/[exceptionId]/renew/route.ts',
    );
    const panel = read('src/components/ControlExceptionsPanel.tsx');
    const detailPage = read(
        'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx',
    );

    // ── 1. Route delegates ─────────────────────────────────────────

    it('GET list delegates to listControlExceptions and POST to requestException', () => {
        expect(listRoute).toMatch(/export const GET/);
        expect(listRoute).toMatch(/export const POST/);
        expect(listRoute).toContain('listControlExceptions');
        expect(listRoute).toContain('requestException');
        expect(listRoute).toContain('RequestExceptionSchema');
        expect(listRoute).toContain('withValidatedBody');
    });

    it('detail GET delegates to getControlException + verifies control hierarchy', () => {
        expect(detailRoute).toContain('getControlException');
        // The route must check `ex.controlId !== params.controlId` so
        // a stale URL doesn't surface a different control's exception.
        expect(detailRoute).toContain('controlId !== params.controlId');
    });

    it('approve / reject / renew routes are typed + validated', () => {
        expect(approveRoute).toContain('approveException');
        expect(approveRoute).toContain('ApproveExceptionSchema');
        expect(approveRoute).toContain('withValidatedBody');
        expect(rejectRoute).toContain('rejectException');
        expect(rejectRoute).toContain('RejectExceptionSchema');
        expect(rejectRoute).toContain('withValidatedBody');
        expect(renewRoute).toContain('renewException');
        expect(renewRoute).toContain('RenewExceptionSchema');
        expect(renewRoute).toContain('withValidatedBody');
    });

    // ── 2. Tenant scoping invariant ─────────────────────────────────

    it('every route uses getTenantCtx', () => {
        for (const src of [
            listRoute,
            detailRoute,
            approveRoute,
            rejectRoute,
            renewRoute,
        ]) {
            expect(src).toContain('getTenantCtx');
        }
    });

    // ── 3. Path-vs-body controlId guard on POST list ───────────────

    it('POST list rejects a body controlId that disagrees with the URL', () => {
        // Critical safety: a malicious caller couldn't post to one
        // control's exception URL and have the body silently
        // re-route to a different control.
        expect(listRoute).toContain('body.controlId !== params.controlId');
    });

    // ── 4. Panel surfaces the canonical workflow buttons ────────────

    it('panel exposes request / approve / reject / renew testids', () => {
        expect(panel).toContain('control-exceptions-panel');
        expect(panel).toContain('control-exception-request-button');
        expect(panel).toContain('control-exception-approve-button-');
        expect(panel).toContain('control-exception-reject-button-');
        expect(panel).toContain('control-exception-renew-button-');
        // Form testids for the dialogs.
        expect(panel).toContain('exception-form-justification');
        expect(panel).toContain('exception-form-compensating-control');
        expect(panel).toContain('exception-form-submit');
        expect(panel).toContain('exception-approve-submit');
        expect(panel).toContain('exception-reject-submit');
        expect(panel).toContain('exception-renew-submit');
    });

    it('panel header badge surfaces "Exception: {STATUS}"', () => {
        expect(panel).toContain('control-exception-header-badge');
        // i18n: the "Exception" label flows through the catalog now; the badge
        // renders `{t('exceptionLabel')}: {ex.status}`. Assert the wiring + that
        // the key still resolves to the canonical English label.
        expect(panel).toContain("t('exceptionLabel')");
        const en = JSON.parse(readRaw('messages/en.json'));
        expect(en.panels.exceptions.exceptionLabel).toBe('Exception');
    });

    it('panel uses the canonical usecases through the API — no raw Prisma', () => {
        expect(panel).not.toContain('prisma');
        expect(panel).not.toContain('@/lib/prisma');
        // Every mutation goes through fetch on the documented routes.
        expect(panel).toContain('/exceptions');
        expect(panel).toContain('/approve');
        expect(panel).toContain('/reject');
        expect(panel).toContain('/renew');
    });

    // ── 5. Control detail page mounts the panel + badge ─────────────

    it('control detail page imports the panel + header badge', () => {
        expect(detailPage).toContain('ControlExceptionsPanel');
        expect(detailPage).toContain('ControlExceptionHeaderBadge');
    });

    it('control detail page renders the badge in the header meta strip', () => {
        // Same `headerMeta` block that owns Status + Applicability
        // badges; the regex tolerates whitespace.
        expect(detailPage).toMatch(
            /<ControlExceptionHeaderBadge[^>]*tenantSlug=\{tenantSlug\}[\s\S]*?controlId=\{control\.id\}/,
        );
    });

    it('control detail page mounts the panel with permission props', () => {
        expect(detailPage).toMatch(/canWrite=\{permissions\.canWrite\}/);
        expect(detailPage).toMatch(/canAdmin=\{permissions\.canAdmin\}/);
    });
});
