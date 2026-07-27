/**
 * EP-2 — Evidence library surfacing tests.
 *
 * Two surfaces:
 *
 *   1. `<EvidenceDetailSheet>` — the fattened detail sheet: inline
 *      preview, unconditional download button, file-metadata block,
 *      review-history timeline, and LOCALIZED status/type (no raw
 *      `SUBMITTED` / `FILE` enum text reaches the DOM).
 *
 *   2. `<EvidenceGallery>` — the first-class gallery: click-to-open on
 *      every card (incl. non-PDF), a download affordance on non-PDF
 *      cards, and a localized status badge.
 *
 * next-intl is mocked to resolve real `messages/en.json` values so the
 * localization assertions are meaningful. The tenant-context + SWR
 * seams are mocked so the sheet renders without a live provider.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

// ─── next/navigation (Modal/Sheet reach for the router) ─────────────
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
}));

// ─── next-intl → resolve against en.json ────────────────────────────
jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns?: string) => (key: string) => {
            const dotted = ns ? `${ns}.${key}` : key;
            let cur: unknown = en;
            for (const part of dotted.split('.')) {
                cur = (cur as Record<string, unknown> | undefined)?.[part];
            }
            return typeof cur === 'string' ? cur : dotted;
        },
    };
});

// ─── tenant-context seams ───────────────────────────────────────────
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

// ─── SWR detail read — driven by a per-test fixture ─────────────────
const swrState: { data: unknown; isLoading: boolean; error: unknown } = {
    data: undefined,
    isLoading: false,
    error: undefined,
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => swrState,
}));

// CopyText pulls in toast + clipboard hooks that want providers — mock
// it to a simple passthrough so the SHA-256 value still renders.
jest.mock('@/components/ui/copy-text', () => ({
    CopyText: ({ children }: { children?: React.ReactNode }) => (
        <span data-testid="copytext">{children}</span>
    ),
}));

import { EvidenceDetailSheet } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet';
import {
    EvidenceGallery,
    type EvidenceGalleryRow,
} from '@/components/ui/EvidenceGallery';

const SHA = 'a'.repeat(64);

function imageEvidence(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ev_1',
        title: 'Architecture diagram',
        description: 'System boundary diagram.',
        content: null,
        type: 'FILE',
        status: 'SUBMITTED',
        fileName: 'diagram.png',
        fileSize: 20480,
        fileRecordId: 'fr_1',
        nextReviewDate: '2026-12-01T00:00:00.000Z',
        retentionUntil: '2027-01-01T00:00:00.000Z',
        expiredAt: null,
        reviewCycle: 'QUARTERLY',
        owner: 'Alice',
        ownerUserId: 'usr_alice',
        // EP-3 — where-used associations (many-to-many controls + back-refs).
        evidenceControlLinks: [],
        taskId: null,
        riskId: null,
        assetId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
        fileRecord: {
            scanStatus: 'CLEAN',
            id: 'fr_1',
            originalName: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 20480,
            sha256: SHA,
            retentionUntil: '2027-01-01T00:00:00.000Z',
        },
        reviews: [
            {
                id: 'rev_1',
                action: 'APPROVED',
                comment: 'Looks good to me.',
                createdAt: '2026-06-02T10:00:00.000Z',
                reviewer: { name: 'Bob Reviewer', email: 'bob@example.test' },
            },
        ],
        ...overrides,
    };
}

function renderSheet(evidence: unknown, props: Record<string, unknown> = {}) {
    swrState.data = evidence;
    swrState.isLoading = false;
    swrState.error = undefined;
    return render(
        <EvidenceDetailSheet
            open
            setOpen={() => {}}
            evidenceId="ev_1"
            tenantSlug="acme"
            canWrite
            canAdmin
            onEdit={() => {}}
            onReview={jest.fn()}
            {...props}
        />,
    );
}

describe('EP-2 — <EvidenceDetailSheet>', () => {
    afterEach(() => {
        swrState.data = undefined;
    });

    it('renders an inline image preview for image evidence', () => {
        renderSheet(imageEvidence());
        expect(
            screen.getByTestId('evidence-sheet-preview-image'),
        ).toBeInTheDocument();
    });

    it('renders a PDF embed for PDF evidence', () => {
        renderSheet(
            imageEvidence({
                title: 'SOC 2 report',
                fileName: 'report.pdf',
                fileRecord: {
            scanStatus: 'CLEAN',
                    id: 'fr_1',
                    originalName: 'report.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 51200,
                    sha256: SHA,
                    retentionUntil: null,
                },
            }),
        );
        expect(
            screen.getByTestId('evidence-sheet-preview-pdf'),
        ).toBeInTheDocument();
    });

    it('always renders a download button for file-backed evidence', () => {
        renderSheet(imageEvidence());
        const btn = document.getElementById('evidence-sheet-download-btn');
        expect(btn).not.toBeNull();
        expect(btn?.getAttribute('href')).toContain(
            '/api/t/acme/evidence/files/fr_1/download',
        );
    });

    it('renders the file-metadata block (name / size / MIME / SHA-256)', () => {
        renderSheet(imageEvidence());
        expect(
            screen.getByTestId('evidence-sheet-file-meta'),
        ).toBeInTheDocument();
        // Filename + human-readable size + MIME + SHA-256.
        expect(screen.getAllByText('diagram.png').length).toBeGreaterThan(0);
        expect(screen.getByText('20.0 KB')).toBeInTheDocument();
        expect(screen.getByText('image/png')).toBeInTheDocument();
        expect(screen.getByText(SHA)).toBeInTheDocument();
    });

    it('renders the review-history timeline with localized action + reviewer', () => {
        renderSheet(imageEvidence());
        expect(
            screen.getByTestId('evidence-sheet-review-history'),
        ).toBeInTheDocument();
        expect(screen.getByTestId('evidence-review-rev_1')).toBeInTheDocument();
        expect(screen.getByText('Bob Reviewer')).toBeInTheDocument();
        expect(screen.getByText('Looks good to me.')).toBeInTheDocument();
    });

    it('shows the empty-history state when there are no reviews', () => {
        renderSheet(imageEvidence({ reviews: [] }));
        expect(
            screen.getByText('No review activity yet'),
        ).toBeInTheDocument();
    });

    it('localizes status + type — no raw enum text reaches the DOM', () => {
        renderSheet(imageEvidence());
        // Localized labels present.
        expect(screen.getByText('Submitted')).toBeInTheDocument();
        expect(screen.getByText('File')).toBeInTheDocument();
        expect(screen.getByText('Approved')).toBeInTheDocument();
        // Raw enum members must NOT appear anywhere.
        expect(screen.queryByText('SUBMITTED')).toBeNull();
        expect(screen.queryByText('APPROVED')).toBeNull();
        expect(screen.queryByText('FILE')).toBeNull();
    });

    it('renders a Re-review action for NEEDS_REVIEW evidence', () => {
        renderSheet(imageEvidence({ status: 'NEEDS_REVIEW' }));
        const btn = document.getElementById('evidence-sheet-rereview-btn');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toContain('Re-review');
    });
});

// ─── Gallery — EP-2 additions ───────────────────────────────────────

const galleryFileUrl = (row: EvidenceGalleryRow): string | null =>
    row.fileRecordId
        ? `/api/t/acme/evidence/files/${row.fileRecordId}/download`
        : null;

describe('EP-2 — <EvidenceGallery> first-class parity', () => {
    it('fires onRowClick when a non-PDF (image) card is clicked', () => {
        const onRowClick = jest.fn();
        render(
            <EvidenceGallery
                rows={[
                    { id: 'img', title: 'IMG', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fA', fileRecord: { scanStatus: 'CLEAN' } },
                ]}
                fileUrl={galleryFileUrl}
                onRowClick={onRowClick}
            />,
        );
        fireEvent.click(screen.getByTestId('evidence-gallery-card-img'));
        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe('img');
    });

    it('renders a download affordance on a non-PDF (image) card', () => {
        render(
            <EvidenceGallery
                rows={[
                    { id: 'img', title: 'IMG', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fA', fileRecord: { scanStatus: 'CLEAN' } },
                ]}
                fileUrl={galleryFileUrl}
                downloadLabel="Download file"
            />,
        );
        const dl = screen.getByTestId('evidence-gallery-download-img');
        expect(dl.tagName).toBe('A');
        expect(dl.getAttribute('href')).toBe(
            '/api/t/acme/evidence/files/fA/download',
        );
        expect(dl.getAttribute('aria-label')).toBe('Download file');
    });

    it('renders the localized status label on cards', () => {
        render(
            <EvidenceGallery
                rows={[
                    { id: 'nr', title: 'NR', fileName: 'a.png', type: 'FILE', status: 'NEEDS_REVIEW', fileRecordId: 'fA', fileRecord: { scanStatus: 'CLEAN' } },
                ]}
                fileUrl={galleryFileUrl}
                statusLabel={(s) =>
                    ({ NEEDS_REVIEW: 'Needs Review' } as Record<string, string>)[s] ?? s
                }
            />,
        );
        expect(screen.getByText('Needs Review')).toBeInTheDocument();
        expect(screen.queryByText('NEEDS_REVIEW')).toBeNull();
    });

    it('wires per-card selection to the shared selection state', () => {
        const onToggleSelect = jest.fn();
        render(
            <EvidenceGallery
                rows={[
                    { id: 'img', title: 'IMG', fileName: 'a.png', type: 'FILE', status: 'APPROVED', fileRecordId: 'fA', fileRecord: { scanStatus: 'CLEAN' } },
                ]}
                fileUrl={galleryFileUrl}
                selectedIds={new Set<string>()}
                onToggleSelect={onToggleSelect}
            />,
        );
        fireEvent.click(screen.getByTestId('evidence-gallery-select-img'));
        expect(onToggleSelect).toHaveBeenCalledWith('img', true);
    });
});
