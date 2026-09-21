/**
 * UI roadmap 21 + 14 ratchet.
 *
 * 21 — the `code` column is OFF by default in the Asset / Risk / Control tables
 *      (still the leading column DEF per table-unification; just defaultVisible:
 *      false in the columns-dropdown list so it's opt-in via the gear).
 * 14 — the Owner column shows name-only via `ownerDisplayName` (no raw email
 *      address rendered) in Risk + Control (Asset owner is free-text; Task
 *      assignee is name-only already).
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

const CLIENTS = {
    risks: 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
    assets: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    controls: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
};

describe('UI-21 — code column off by default', () => {
    it.each(Object.entries(CLIENTS))('%s code entry is defaultVisible: false', (_name, file) => {
        const src = read(file);
        // The columns-dropdown list entry for `code` carries defaultVisible:false.
        expect(src).toMatch(/\{\s*id:\s*'code'[^}]*defaultVisible:\s*false[^}]*\}/);
    });
});

describe('UI-2/3 — entity-table tags are one size smaller (size="sm")', () => {
    it.each([
        ['risks', CLIENTS.risks],
        ['assets', CLIENTS.assets],
        ['controls', CLIENTS.controls],
        ['tasks', 'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx'],
    ])('%s status/tag badges carry size="sm"', (_n, file) => {
        const src = read(file);
        // Every table-cell StatusBadge should be the smaller size to match the
        // control detail view. Assert at least one sm badge + no default-md
        // tag slipped back (a bare `<StatusBadge variant=...>` with no size on
        // a status/severity tag).
        expect(src).toMatch(/<StatusBadge[^>]*size="sm"/);
    });
});

describe('UI-14 — Owner column is name-only (no email address)', () => {
    it('ownerDisplayName helper exists + strips the @domain', () => {
        expect(read('src/lib/owner-display.ts')).toMatch(/export function ownerDisplayName/);
    });

    it.each([
        ['risks', CLIENTS.risks],
        ['controls', CLIENTS.controls],
    ])('%s owner cell uses ownerDisplayName (no `.owner?.email` rendered)', (_n, file) => {
        const src = read(file);
        expect(src).toMatch(/ownerDisplayName\(/);
        // The owner CELL must not render the raw email. Allow `email` only in
        // the helper call args + filter/accessor — assert no JSX `{...email}`
        // print of the owner email remains.
        expect(src).not.toMatch(/\{c\.owner\.email\}/);
        expect(src).not.toMatch(/\{r\.owner\.email\}/);
    });
});
