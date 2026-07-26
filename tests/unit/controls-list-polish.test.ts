/**
 * Structural ratchet — Controls list UX polish.
 *
 * Locks the visible-change deltas applied after Epic 91's
 * structural-only refactor:
 *
 *   1. Owner column renders an avatar + name + email chip (data
 *      already comes back from the repo's `owner` include).
 *   2. Status pill is a read-only `<StatusBadge id="status-pill-{id}">`.
 *      The inline-edit `<select>` dropdown was retired 2026-05-19 at
 *      the user's request; status changes route through the detail
 *      page or the bulk-set toolbar actions.
 *   3. Applicability pill is a read-only `<StatusBadge
 *      id="applicability-pill-{id}">`. Same retirement as Status;
 *      the justification modal lives on the detail page now.
 *   4. Evidence column carries a `<Paperclip>` icon next to the count.
 *   5. The bulk-status operations (Mark Implemented / Needs Review /
 *      Not Applicable) render in the selection-summary rail
 *      (`<SelectionSummaryPanel>`) — right-rail Phase 2 retired the
 *      floating `batchActions` toolbar in favour of the docked rail.
 *
 * This is a string-scan ratchet — same shape as
 * `controls-client-shell-adoption.test.ts`. It runs in the node
 * project so it doesn't need a jsdom mount.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONTROLS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
);
const source = readFileSync(CONTROLS_CLIENT, 'utf8');

describe('Controls list — UX polish', () => {
    describe('Owner column', () => {
        it('renders a name-only chip with initial avatar (no email)', () => {
            // Avatar circle uses the first character of the display
            // string; locking this so a future "tidy-up" can't drop
            // the avatar back to a plain text cell.
            expect(source).toContain("data-testid={`control-owner-${c.id}`}");
            expect(source).toMatch(/charAt\(0\)\.toUpperCase\(\)/);
            // UI-14: name-only via ownerDisplayName (name → email local-part as
            // username); the full email address is no longer rendered.
            expect(source).toMatch(/ownerDisplayName\(c\.owner\?\.name,\s*c\.owner\?\.email\)/);
            expect(source).not.toMatch(/\{c\.owner\.email\}/);
            expect(source).toContain('text-content-subtle');
        });
    });

    describe('Status read-only badge (dropdown retired 2026-05-19)', () => {
        it('renders as a <StatusBadge id="status-pill-{id}">', () => {
            // The inline-edit `<select>` was retired 2026-05-19 at
            // the user's request. The cell is now a read-only badge
            // for every viewer; status changes route through the
            // per-control detail page or the bulk-set toolbar
            // actions. E2E selector `#status-pill-{id}` preserved
            // on the badge for parity with existing tests.
            expect(source).toMatch(
                /<StatusBadge\s+id=\{`status-pill-\$\{c\.id\}`\}/,
            );
            // The cell must NOT carry an inline-edit `<select>` or
            // any of the legacy `setJustification` / handler hooks.
            expect(source).not.toMatch(
                /<select\s+id=\{`status-pill-\$\{c\.id\}`\}/,
            );
            // ALL_STATUSES + the dropdown <option> map are gone too.
            expect(source).not.toContain('ALL_STATUSES');
        });

        it('no permission branch — read-only for every viewer', () => {
            // Pre-2026-05-19 the cell had two branches (editable
            // `<select>` for editors, read-only badge for readers).
            // The new shape is single-branch; the permission gate
            // is gone for this cell. A future PR that re-adds an
            // `if (!appPermissions.controls.edit)` inside the
            // Status accessor would regress the simplification.
            const statusCell = source.match(
                /accessorKey: 'status',[\s\S]+?\}\,\s+\{/,
            );
            expect(statusCell).not.toBeNull();
            expect(statusCell![0]).not.toMatch(
                /appPermissions\.controls\.edit/,
            );
        });
    });

    describe('Applicability read-only badge (dropdown retired 2026-05-19)', () => {
        it('renders as a <StatusBadge id="applicability-pill-{id}">', () => {
            expect(source).toMatch(
                /<StatusBadge\s+id=\{`applicability-pill-\$\{c\.id\}`\}/,
            );
            expect(source).not.toMatch(
                /<select\s+id=\{`applicability-pill-\$\{c\.id\}`\}/,
            );
        });

        it('justification modal infrastructure removed from the list page', () => {
            // The Not-Applicable justification flow now lives on the
            // per-control detail page only. The list page no longer
            // mounts the modal, the applicability mutation, or any
            // of the supporting state.
            expect(source).not.toContain('setJustificationModal');
            expect(source).not.toContain('applicabilityMutation');
            // NB: the list page DOES legitimately host a <Modal> now — the
            // typed-confirmation Purge modal for the Deleted-controls
            // lifecycle view. So we no longer assert the absence of <Modal>;
            // only the justification-specific infrastructure is gone.
        });
    });

    describe('Evidence count column', () => {
        it('renders a Paperclip icon next to the count', () => {
            expect(source).toMatch(
                /import\s*\{[^}]*\bPaperclip\b[^}]*\}\s*from\s*['"]lucide-react['"]/,
            );
            expect(source).toMatch(/<Paperclip\s/);
            expect(source).toContain("data-testid={`control-evidence-${row.original.id}`}");
        });
    });

    describe('Bulk actions — canonical BulkActionBar (header-row selection bar)', () => {
        it('mounts the canonical BulkActionBar with status + assign actions via selectionControls', () => {
            // The bulk actions render in the DataTable's header-row
            // selection toolbar via the shared <BulkActionBar> (the same
            // primitive Tasks/Assets use), NOT the retired
            // SelectionSummaryPanel right-rail or the former three-verb
            // batchActions.
            expect(source).toMatch(/selectionControls:\s*canEditControls/);
            expect(source).toMatch(/<BulkActionBar\b/);
            expect(source).toMatch(/actions=\{controlBulkActions\}/);
            expect(source).toMatch(/value: 'status'/);
            expect(source).toMatch(/value: 'assign'/);
            expect(source).not.toContain('<SelectionSummaryPanel');
            expect(source).not.toMatch(/batchActions:\s*controlBatchActions/);
        });

        it('bulk status/assign go through one updateMany endpoint, not a per-id loop', () => {
            // The former bulkSetStatus N+1 (one POST per selected id) is
            // replaced by a single POST to the /controls/bulk/* endpoints.
            expect(source).toMatch(/\/controls\/bulk\/status/);
            expect(source).toMatch(/\/controls\/bulk\/assign/);
            expect(source).not.toMatch(/const bulkSetStatus =/);
        });

        it('the bulk actions are permission-gated (canEditControls)', () => {
            // READER sees neither checkboxes nor the action bar; the
            // selectionControls slot only mounts when the viewer can edit.
            expect(source).toMatch(
                /selectionControls:\s*canEditControls\s*\n?\s*\?/,
            );
        });
    });
});
