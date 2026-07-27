/**
 * `<EvidenceGallery>` rendered tests — Epic 43.2.
 *
 * Locks the gallery's UX contract:
 *   - empty / loading states render correctly
 *   - image rows render an inline `<img loading=lazy decoding=async>`
 *     pointing at the `fileUrl(row)` URL
 *   - PDF rows render the PDF preview placeholder linking to the URL
 *   - non-previewable rows render the file-type icon fallback
 *   - LINK / TEXT rows fall back to their domain-kind icon family
 *   - mixed-row grids work in one render (no special-casing leaks)
 *   - per-card freshness badge fires for each row (compact)
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import {
    EvidenceGallery,
    type EvidenceGalleryRow,
} from '@/components/ui/EvidenceGallery';

const NOW = new Date('2026-04-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// Typed against the gallery's row contract so the generic inference
// in `<EvidenceGallery rows={...} fileUrl={fileUrl} />` lines up
// regardless of which subset of optional fields each test fixture
// supplies.
const fileUrl = (row: EvidenceGalleryRow): string | null =>
    row.fileRecordId
        ? `/api/t/acme/evidence/files/${row.fileRecordId}/download`
        : null;

describe('<EvidenceGallery>', () => {
    it('renders the empty state when rows is empty', () => {
        render(
            <EvidenceGallery
                rows={[]}
                fileUrl={fileUrl}
                emptyState="Nothing here"
            />,
        );
        expect(screen.getByTestId('evidence-gallery-empty')).toBeInTheDocument();
        expect(screen.getByText('Nothing here')).toBeInTheDocument();
    });

    it('renders a loading skeleton when loading + no rows', () => {
        render(<EvidenceGallery rows={[]} loading fileUrl={fileUrl} />);
        expect(
            screen.getByTestId('evidence-gallery-loading'),
        ).toBeInTheDocument();
    });

    it('renders an image card with a lazy-loaded thumbnail for image rows', () => {
        render(
            <EvidenceGallery
                rows={[
                    {
                        id: 'a',
                        title: 'Architecture diagram',
                        fileName: 'arch.png',
                        type: 'FILE',
                        status: 'APPROVED',
                        fileRecordId: 'fr_1', fileRecord: { scanStatus: 'CLEAN' },
                        lastRefreshedAt: daysAgo(2),
                    },
                ]}
                fileUrl={fileUrl}
            />,
        );
        const thumb = screen.getByTestId(
            'evidence-gallery-thumb-a',
        ) as HTMLImageElement;
        expect(thumb.tagName).toBe('IMG');
        expect(thumb.getAttribute('loading')).toBe('lazy');
        expect(thumb.getAttribute('decoding')).toBe('async');
        expect(thumb.getAttribute('src')).toBe(
            '/api/t/acme/evidence/files/fr_1/download',
        );
    });

    it('renders the PDF preview placeholder for PDF rows', () => {
        render(
            <EvidenceGallery
                rows={[
                    {
                        id: 'b',
                        title: 'SOC 2 report',
                        fileName: 'report.pdf',
                        type: 'FILE',
                        status: 'SUBMITTED',
                        fileRecordId: 'fr_2', fileRecord: { scanStatus: 'CLEAN' },
                        lastRefreshedAt: daysAgo(5),
                    },
                ]}
                fileUrl={fileUrl}
            />,
        );
        const a = screen.getByTestId('evidence-gallery-pdfthumb-b');
        expect(a.tagName).toBe('A');
        expect(a.getAttribute('href')).toBe(
            '/api/t/acme/evidence/files/fr_2/download',
        );
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toContain('noopener');
    });

    it('renders the file-type icon fallback for CSV / DOCX / ZIP', () => {
        render(
            <EvidenceGallery
                rows={[
                    {
                        id: 'c',
                        title: 'Inventory export',
                        fileName: 'data.csv',
                        type: 'FILE',
                        status: 'APPROVED',
                        fileRecordId: 'fr_3', fileRecord: { scanStatus: 'CLEAN' },
                        lastRefreshedAt: daysAgo(1),
                    },
                    {
                        id: 'd',
                        title: 'Policy bundle',
                        fileName: 'pack.zip',
                        type: 'FILE',
                        status: 'APPROVED',
                        fileRecordId: 'fr_4', fileRecord: { scanStatus: 'CLEAN' },
                        lastRefreshedAt: daysAgo(40),
                    },
                ]}
                fileUrl={fileUrl}
            />,
        );
        expect(
            screen.getByTestId('evidence-gallery-iconfallback-c'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('evidence-gallery-iconfallback-d'),
        ).toBeInTheDocument();
    });

    it('renders LINK and TEXT rows with their domain-kind icon families', () => {
        render(
            <EvidenceGallery
                rows={[
                    { id: 'link', title: 'External vendor portal', type: 'LINK', status: 'APPROVED' },
                    { id: 'text', title: 'Inline note', type: 'TEXT', status: 'DRAFT' },
                ]}
                fileUrl={fileUrl}
            />,
        );
        const linkCard = screen.getByTestId('evidence-gallery-card-link');
        expect(linkCard.getAttribute('data-file-kind')).toBe('link');
        const textCard = screen.getByTestId('evidence-gallery-card-text');
        expect(textCard.getAttribute('data-file-kind')).toBe('text');
    });

    it('renders a mixed grid (image + PDF + CSV + LINK) in one render', () => {
        render(
            <EvidenceGallery
                rows={[
                    { id: '1', title: 'A', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'f1', fileRecord: { scanStatus: 'CLEAN' } },
                    { id: '2', title: 'B', fileName: 'b.pdf', type: 'FILE', status: 'APPROVED', fileRecordId: 'f2', fileRecord: { scanStatus: 'CLEAN' } },
                    { id: '3', title: 'C', fileName: 'c.csv', type: 'FILE', status: 'APPROVED', fileRecordId: 'f3', fileRecord: { scanStatus: 'CLEAN' } },
                    { id: '4', title: 'D', type: 'LINK', status: 'APPROVED' },
                ]}
                fileUrl={fileUrl}
            />,
        );
        // Image: <img>
        expect(screen.getByTestId('evidence-gallery-thumb-1').tagName).toBe('IMG');
        // PDF: <a>
        expect(screen.getByTestId('evidence-gallery-pdfthumb-2').tagName).toBe('A');
        // CSV: icon fallback
        expect(
            screen.getByTestId('evidence-gallery-iconfallback-3'),
        ).toBeInTheDocument();
        // LINK: card present + kind set
        expect(
            screen.getByTestId('evidence-gallery-card-4').getAttribute('data-file-kind'),
        ).toBe('link');
    });

    it('fires onRowClick for non-PDF cards and stops the PDF link from bubbling', () => {
        const onRowClick = jest.fn();
        render(
            <EvidenceGallery
                rows={[
                    { id: 'img', title: 'IMG', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fA', fileRecord: { scanStatus: 'CLEAN' } },
                    { id: 'pdf', title: 'PDF', fileName: 'b.pdf', type: 'FILE', status: 'APPROVED', fileRecordId: 'fB', fileRecord: { scanStatus: 'CLEAN' } },
                ]}
                fileUrl={fileUrl}
                onRowClick={onRowClick}
            />,
        );
        // Click image card → fires
        fireEvent.click(screen.getByTestId('evidence-gallery-card-img'));
        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe('img');
        // Click PDF preview link → e.stopPropagation prevents the row click
        fireEvent.click(screen.getByTestId('evidence-gallery-pdfthumb-pdf'));
        expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    it('renders a freshness badge for each row', () => {
        render(
            <EvidenceGallery
                rows={[
                    { id: 'r1', title: 'A', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fr1', fileRecord: { scanStatus: 'CLEAN' }, lastRefreshedAt: daysAgo(2) },
                    { id: 'r2', title: 'B', fileName: 'b.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fr2', fileRecord: { scanStatus: 'CLEAN' }, lastRefreshedAt: daysAgo(40) },
                    { id: 'r3', title: 'C', fileName: 'c.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fr3', fileRecord: { scanStatus: 'CLEAN' }, lastRefreshedAt: null },
                ]}
                fileUrl={fileUrl}
            />,
        );
        expect(screen.getByTestId('evidence-gallery-freshness-r1')).toBeInTheDocument();
        expect(screen.getByTestId('evidence-gallery-freshness-r2')).toBeInTheDocument();
        expect(screen.getByTestId('evidence-gallery-freshness-r3')).toBeInTheDocument();
    });

    it('hides the thumbnail when fileUrl returns null (no fileRecord)', () => {
        render(
            <EvidenceGallery
                rows={[
                    {
                        id: 'pending',
                        title: 'Pending',
                        fileName: 'p.png',
                        type: 'FILE',
                        status: 'PENDING_UPLOAD',
                        fileRecordId: null,
                    },
                ]}
                fileUrl={fileUrl}
            />,
        );
        // No <img> or PDF link — falls back to the icon
        expect(
            screen.queryByTestId('evidence-gallery-thumb-pending'),
        ).toBeNull();
        expect(
            screen.getByTestId('evidence-gallery-iconfallback-pending'),
        ).toBeInTheDocument();
    });
});
