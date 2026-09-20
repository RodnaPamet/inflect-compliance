/**
 * Epic 43.1 — file-type icon column on the evidence DataTable.
 *
 * Two layers of coverage:
 *
 *   1. Rendered: mount a minimal subset that exercises
 *      `resolveFileTypeIcon` against a row mix of FILE / LINK / TEXT
 *      and assert each kind renders the right Lucide glyph + label.
 *      Anchored on the `<FileTypeIcon>` primitive so we don't mount
 *      the full EvidenceClient (which carries heavy data + filter
 *      dependencies that aren't relevant here).
 *
 *   2. Structural: scan EvidenceClient's source so a future "tidy-up"
 *      can't silently re-introduce the FILE-only badge.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { render, screen } from '@testing-library/react';

import { FileTypeIcon } from '@/components/ui/file-type-icon';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}
const EVIDENCE_CLIENT =
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';

describe('evidence list — file-type icon column', () => {
    describe('rendered (mixed file types)', () => {
        it('renders distinct labels per row kind', () => {
            const rows = [
                { id: '1', type: 'FILE', fileName: 'audit.pdf' },
                { id: '2', type: 'FILE', fileName: 'data.csv' },
                { id: '3', type: 'FILE', fileName: 'photo.jpg' },
                { id: '4', type: 'FILE', fileName: 'pack.zip' },
                { id: '5', type: 'LINK', fileName: null },
                { id: '6', type: 'TEXT', fileName: null },
            ];
            render(
                <ul>
                    {rows.map((r) => (
                        <li key={r.id}>
                            <FileTypeIcon
                                fileName={r.fileName}
                                domainKind={r.type}
                                data-testid={`row-icon-${r.id}`}
                            />
                        </li>
                    ))}
                </ul>,
            );
            // Each icon's `aria-label` reflects the resolved label —
            // the user-visible legend in the UI.
            const labels = rows.map(
                (r) =>
                    screen.getByTestId(`row-icon-${r.id}`).getAttribute(
                        'aria-label',
                    )!,
            );
            // PDF / CSV / Image / Archive / Link / Text in row order.
            expect(labels).toEqual([
                'PDF',
                'CSV',
                'Image',
                'Archive',
                'Link',
                'Text',
            ]);
        });

        it('exposes data-file-kind for E2E hooks', () => {
            render(
                <FileTypeIcon
                    fileName="ledger.xlsx"
                    data-testid="ledger"
                />,
            );
            expect(
                screen
                    .getByTestId('ledger')
                    .getAttribute('data-file-kind'),
            ).toBe('spreadsheet');
        });
    });

    describe('structural — EvidenceClient adoption', () => {
        const src = read(EVIDENCE_CLIENT);

        it('imports resolveFileTypeIcon from the canonical path', () => {
            // R13-PR1 retired the inline <FileTypeIcon> mount in the
            // title cell — the Type column now drives the icon via
            // `resolveFileTypeIcon(...)` + `<match.Icon>` (see the
            // "Type column still resolves..." assertion below). The
            // bare `FileTypeIcon` component is unused HERE (it stays
            // canonical in `FileDropzone` and `EvidenceGallery`); the
            // quality-roadmap unused-import sweep removed the dead
            // import. Only the helper that's actually rendered stays
            // structurally asserted.
            expect(src).toMatch(
                /import\s*\{[^}]*\bresolveFileTypeIcon\b[^}]*\}\s*from\s*['"]@\/components\/ui\/file-type-icon['"]/,
            );
        });

        it('routes title text through the canonical TableTitleCell primitive (R13-PR1)', () => {
            // Pre-R13 the title cell mounted <FileTypeIcon> + a
            // 2-line title/filename block, which broke row-height
            // uniformity across the product. R13-PR1 moved file-
            // type signalling to the dedicated Type column (still
            // resolved via resolveFileTypeIcon, see assertion below)
            // and replaced the title cell with <TableTitleCell>.
            expect(src).toMatch(/<TableTitleCell\b/);
        });

        it('Type column still resolves a file-type icon via resolveFileTypeIcon', () => {
            // The icon survived the R13-PR1 migration — it just
            // moved out of the title cell into the dedicated Type
            // column. resolveFileTypeIcon + the per-kind <match.Icon>
            // mount is the canonical surface.
            expect(src).toContain('resolveFileTypeIcon(');
            expect(src).toMatch(/<match\.Icon/);
        });

        it('replaces the FILE-only badge in the type column with a resolved icon + label', () => {
            // Regression guard — the previous column rendered a
            // single `badge ${ev.type === 'FILE' ? 'badge-success' :
            // 'badge-info'}` block. After Epic 43.1 the cell calls
            // resolveFileTypeIcon with the row's fileName + MIME +
            // kind. A "tidy-up" PR that reverted to the badge would
            // fail this check.
            expect(src).toContain('resolveFileTypeIcon(');
            expect(src).not.toMatch(
                /ev\.type === ['"]FILE['"] \? ['"]badge-success['"] : ['"]badge-info['"]/,
            );
        });

        it('preserves the existing retention status badge column', () => {
            // The expiry-state badge is already rendered via
            // `getRetentionStatus(ev, hydratedNow)`. Locking it down
            // here so the icon-column work doesn't accidentally
            // remove the second badge the prompt requires.
            expect(src).toContain(`id={\`retention-status-\${ev.id}\`}`);
            expect(src).toMatch(/getRetentionStatus\(ev,/);
        });
    });
});
