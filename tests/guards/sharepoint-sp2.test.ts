/**
 * SP-2 ratchet — the SharePoint browse plane must stay wired: the practitioner
 * browse/sites routes (evidence.upload-gated), the service flatteners, and the
 * file-picker component's core affordances (multi/single select, type filter,
 * breadcrumb, lazy folder load via the browse route).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-2 SharePoint browser', () => {
    it('the practitioner browse + sites routes exist and are evidence.upload-gated', () => {
        const base = 'src/app/api/t/[tenantSlug]/integrations/sharepoint';
        for (const f of ['browse/route.ts', 'sites/route.ts']) {
            expect(exists(`${base}/${f}`)).toBe(true);
            expect(read(`${base}/${f}`)).toMatch(/requirePermission(<[^>]*>)?\(\s*'evidence\.upload'/);
        }
    });

    it('the service flattens DriveItems + resolves sites/drives', () => {
        const svc = read('src/app-layer/integrations/providers/sharepoint/service.ts');
        expect(svc).toMatch(/export async function browseSharePoint/);
        expect(svc).toMatch(/export async function getSharePointSitesAndDrives/);
        expect(svc).toMatch(/isFolder/);
    });

    it('the file picker supports multi/single select, type filter, breadcrumb + lazy browse', () => {
        const f = 'src/components/integrations/sharepoint/SharePointFilePicker.tsx';
        expect(exists(f)).toBe(true);
        const src = read(f);
        expect(src).toMatch(/multiple/);
        expect(src).toMatch(/Filter/); // file-type filter
        expect(src).toMatch(/breadcrumb|gotoCrumb|path\.map/i);
        expect(src).toMatch(/\/integrations\/sharepoint\/browse/);
        expect(src).toMatch(/\/integrations\/sharepoint\/sites/);
        expect(src).toMatch(/onConfirm/);
    });
});
