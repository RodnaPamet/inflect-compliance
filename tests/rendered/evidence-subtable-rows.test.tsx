/**
 * `<EvidenceSubTable>` — what a row on a control's Evidence tab reads (#4126).
 *
 *   - Status and type go through the library's own label helpers, so a
 *     record reads "Draft" / "File" as it does in the library, not the raw
 *     `DRAFT` / `FILE` enum.
 *   - "Added by" names the person for a library record too. It was a dash
 *     for every one, because only plain-link rows carried a creator.
 *   - A plain link (a `ControlEvidenceLink` row, never in the library) is
 *     labelled as one, says it has no review status, and shows its note
 *     beside its address. The note used to render only when there was NO
 *     address, so a web link's note never showed.
 *   - A library LINK record's title opens it in the library, where it is
 *     reviewed, and its address sits under the title.
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { EvidenceSubTable, type EvidenceTabData } from '@/components/controls-shared/EvidenceSubTable';

const tenantHref = (p: string) => `/t/acme${p}`;

const DATA: EvidenceTabData = {
    links: [
        {
            id: 'link_1',
            kind: 'LINK',
            url: 'https://example.com/old-link',
            note: 'Saved before links were library records',
            createdAt: '2026-09-01T00:00:00.000Z',
            createdBy: { id: 'user_2', name: 'Bea Plain' },
        },
    ],
    evidence: [
        {
            id: 'ev_file',
            type: 'FILE',
            title: 'Access review export',
            content: null,
            status: 'DRAFT',
            fileRecordId: 'fr_1',
            createdAt: '2026-10-01T00:00:00.000Z',
            addedBy: { id: 'user_1', name: 'Ada Library' },
        },
        {
            id: 'ev_link',
            type: 'LINK',
            title: 'Q3 access review',
            content: 'https://example.com/report',
            status: 'APPROVED',
            fileRecordId: null,
            createdAt: '2026-10-02T00:00:00.000Z',
            addedBy: { id: 'user_1', name: 'Ada Library' },
        },
    ],
};

function rowFor(text: string): HTMLElement {
    const cell = screen.getByText(text);
    const row = cell.closest('tr');
    if (!row) throw new Error(`no row holds "${text}"`);
    return row as HTMLElement;
}

describe('EvidenceSubTable — rows', () => {
    beforeEach(() => {
        render(
            <EvidenceSubTable
                data={DATA}
                loading={false}
                canWrite
                onUnlink={() => {}}
                tenantHref={tenantHref}
            />,
        );
    });

    it('labels a library record the way the library does', () => {
        const file = within(rowFor('Access review export'));
        expect(file.getByText('File')).toBeInTheDocument();
        expect(file.getByText('Draft')).toBeInTheDocument();
        expect(file.queryByText('FILE')).toBeNull();
        expect(file.queryByText('DRAFT')).toBeNull();

        const link = within(rowFor('Q3 access review'));
        expect(link.getByText('Link')).toBeInTheDocument();
        expect(link.getByText('Approved')).toBeInTheDocument();
    });

    it('names who added a library record', () => {
        expect(within(rowFor('Access review export')).getByText('Ada Library')).toBeInTheDocument();
    });

    it("opens a library LINK record in the library and shows its address under it", () => {
        const row = within(rowFor('Q3 access review'));
        expect(row.getByText('Q3 access review').closest('a')).toHaveAttribute('href', '/t/acme/evidence?ev=ev_link');
        const external = row.getByText('https://example.com/report').closest('a');
        expect(external).toHaveAttribute('href', 'https://example.com/report');
        expect(external).toHaveAttribute('target', '_blank');
    });

    it('labels a plain link as one, with no review status, and shows its note beside its address', () => {
        const row = within(rowFor('https://example.com/old-link'));
        expect(row.getByText('Plain link')).toBeInTheDocument();
        expect(row.getByText('No review status')).toBeInTheDocument();
        expect(row.getByText('Saved before links were library records')).toBeInTheDocument();
        expect(row.getByText('Bea Plain')).toBeInTheDocument();
        // Still removable from the control.
        expect(document.getElementById('unlink-link_1')).not.toBeNull();
    });
});

describe('EvidenceSubTable — an address is followable only when safe', () => {
    const UNSAFE: EvidenceTabData = {
        links: [
            {
                id: 'link_js',
                kind: 'LINK',
                url: 'javascript:alert(1)',
                note: 'A plain link that runs script',
                createdAt: '2026-09-01T00:00:00.000Z',
                createdBy: { id: 'user_2', name: 'Bea Plain' },
            },
        ],
        evidence: [
            {
                id: 'ev_js',
                type: 'LINK',
                title: 'Library record that runs script',
                content: 'java\tscript:alert(1)',
                status: 'DRAFT',
                fileRecordId: null,
                createdAt: '2026-10-02T00:00:00.000Z',
                addedBy: { id: 'user_1', name: 'Ada Library' },
            },
        ],
    };

    it('shows a javascript: address as text, with no link to it', () => {
        render(<EvidenceSubTable data={UNSAFE} loading={false} canWrite onUnlink={() => {}} tenantHref={tenantHref} />);
        for (const [rowText, address] of [
            ['A plain link that runs script', 'javascript:alert(1)'],
            ['Library record that runs script', 'java\tscript:alert(1)'],
        ] as const) {
            const row = rowFor(rowText);
            // Shown exactly as stored, so a reader sees what was saved.
            expect(row.textContent).toContain(address);
            // The only link left in the row is the library record's own page.
            for (const a of Array.from(row.querySelectorAll('a'))) {
                expect(a.getAttribute('href') ?? '').not.toMatch(/script:/i);
                expect(a.textContent).not.toContain('alert(1)');
            }
        }
    });
});
