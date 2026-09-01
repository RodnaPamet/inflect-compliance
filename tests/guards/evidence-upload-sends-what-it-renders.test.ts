/**
 * The upload modal sends the fields it renders.
 *
 * `UploadEvidenceModal` renders Category, Folder and Retention as enabled
 * inputs inside one `<fieldset>`, and has two submit paths. The dropzone path
 * sent all three. The "Import from SharePoint" path sent NONE of them — the
 * user filled them in, imported, and the values vanished with no warning and
 * nothing disabled to suggest they would not apply.
 *
 * Each third failed for a different reason, which is why this guards all
 * three rather than one:
 *
 *   category    accepted by the route AND the importer all along, and simply
 *               never sent by the client.
 *   folder      accepted by `uploadEvidenceFile`, but ABSENT from the route
 *               schema — unreachable end-to-end, so sending it alone would
 *               have been silently stripped by `.parse()`.
 *   retention   not part of the import contract at all; it is a second write
 *               per row, applied over the ids the route returns.
 *
 * A field that is rendered, enabled, and dropped is worse than one that is
 * missing: the UI makes a promise the write does not keep, and nothing
 * fails. So this asserts the seam end to end rather than at one layer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MODAL = 'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx';
const ROUTE = 'src/app/api/t/[tenantSlug]/integrations/sharepoint/import/route.ts';
const IMPORTER = 'src/app-layer/integrations/providers/sharepoint/import.ts';

/** The object literal posted to the SharePoint import endpoint. */
function spImportBody(src: string): string {
    const at = src.indexOf("sharepoint/import");
    expect(at).toBeGreaterThan(-1);
    const bodyAt = src.indexOf('body: JSON.stringify(', at);
    expect(bodyAt).toBeGreaterThan(-1);
    return src.slice(bodyAt, src.indexOf('});', bodyAt));
}

describe('the SharePoint import sends the fields the modal renders', () => {
    const modal = codeOnly(read(MODAL));

    it('sends category', () => {
        expect(spImportBody(modal)).toMatch(/\bcategory:/);
    });

    it('sends folder', () => {
        expect(spImportBody(modal)).toMatch(/\bfolder:/);
    });

    it('the route accepts both, so neither is stripped by .parse()', () => {
        // `folder` was the one missing here. A client that sends a field the
        // schema does not declare gets it silently dropped — the same
        // failure with an extra layer of indirection.
        const route = codeOnly(read(ROUTE));
        expect(route).toMatch(/category:\s*z\.string\(\)\.optional\(\)/);
        expect(route).toMatch(/folder:\s*z\.string\(\)\.optional\(\)/);
    });

    it('the importer carries both through to uploadEvidenceFile', () => {
        // Accepted at the boundary but dropped before the write would be the
        // same defect one layer deeper.
        const imp = codeOnly(read(IMPORTER));
        expect(imp).toMatch(/category:\s*target\.category/);
        expect(imp).toMatch(/folder:\s*target\.folder/);
    });

    it('importSharePointItems BUILDS that target from the input', () => {
        // The hop the checks above skip, and the one that was actually
        // broken. `importOne` read `target.folder` correctly all along —
        // `importSharePointItems` built `target` from controlId + category
        // only, so `target.folder` was always undefined and the evidence row
        // stored null. Every other layer here was green while the user's
        // chosen folder was discarded, which is the whole reason this file
        // asserts the seam end to end rather than at one layer.
        const imp = codeOnly(read(IMPORTER));
        const at = imp.indexOf('await importOne(');
        expect(at).toBeGreaterThan(-1);
        const call = imp.slice(at, imp.indexOf('),', at));
        expect(call).toMatch(/controlId:\s*input\.controlId/);
        expect(call).toMatch(/category:\s*input\.category/);
        expect(call).toMatch(/folder:\s*input\.folder/);
    });

    it('retention is applied over the ids the import returns', () => {
        // Not part of the import contract — a second write per row, as on
        // the dropzone path.
        expect(modal).toMatch(/applyEvidenceRetentionBatch\(/);
        expect(modal).toMatch(/evidenceIds/);
    });
});

describe('both create paths observe the retention write', () => {
    const modal = codeOnly(read(MODAL));

    it('neither path fires a bare retention fetch any more', () => {
        // The original shape: `await fetch(apiUrl(`…/retention`), {…})` with
        // no check on the response, so a non-ok reply read as success.
        expect(modal).not.toMatch(/fetch\([^)]*\/retention/);
    });

    it('both go through the helper that throws on a non-ok reply', () => {
        expect(modal).toMatch(/from '@\/lib\/evidence-retention-request'/);
        expect(modal).toMatch(/applyEvidenceRetention\(/);
        expect(modal).toMatch(/applyEvidenceRetentionBatch\(/);
    });
});
