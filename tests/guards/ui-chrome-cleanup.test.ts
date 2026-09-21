/**
 * UI roadmap 15 + 18 ratchet — chrome cleanup.
 *
 * 15a — the dashboard no longer renders a notifications button (the top-bar
 *       bell is the single canonical affordance).
 * 15b — the Controls header no longer has a standalone "Frameworks" button.
 * 18  — the evidence +Evidence flow is unified onto the Upload-a-file modal;
 *       the "Upload file" + "Import ZIP" icon buttons + text modal were removed.
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

describe('UI-15 — removed buttons', () => {
    it('dashboard has no notifications header button', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');
        expect(src).not.toMatch(/href=\{href\('\/notifications'\)\}/);
        expect(src).not.toMatch(/unreadNotifications > 0 \?/);
    });
    it('controls header has no Frameworks button', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
        expect(src).not.toContain('frameworks-btn');
        expect(src).not.toMatch(/aria-label="Frameworks"/);
    });
});

describe('UI-18 — evidence create menu', () => {
    // EP-3 replaced the single +Evidence upload button with a create MENU
    // (Popover.Menu) offering the four creation surfaces — File upload / Text
    // note / Link (URL) / Bulk ZIP import — each mounting its own modal.
    const src = read('src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx');
    it('the +Evidence trigger opens a create menu, not a bare upload button', () => {
        expect(src).toMatch(/<Popover\.Menu/);
        expect(src).toContain('create-evidence-upload');
        expect(src).toContain('create-evidence-text');
    });
    it('the create menu mounts all four creation surfaces', () => {
        expect(src).toMatch(/<UploadEvidenceModal\b/);
        expect(src).toMatch(/<NewEvidenceTextModal\b/);
        expect(src).toMatch(/<NewEvidenceLinkModal\b/);
        expect(src).toMatch(/<EvidenceBulkImportModal\b/);
    });
});
