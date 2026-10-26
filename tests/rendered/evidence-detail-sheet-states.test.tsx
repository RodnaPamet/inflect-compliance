/**
 * The Evidence details panel's error, download and unlink states (#4277).
 *
 *   - A failed first load shows the error. The render checked `isLoading ||
 *     !evidence` before `error`, and a failed load leaves `evidence`
 *     undefined, so a `?ev=` link to a deleted record read "Loading…" for ever.
 *   - The preview and the download (and each older version's download) read
 *     the download route, which refuses archived evidence for everyone and
 *     evidence linked to no control for a role below the write tier. The panel
 *     says why instead of offering a link that fails silently.
 *   - A failed unlink puts the control back AND says so; the commit's
 *     `detail.unlinkFailed` used to be thrown into an `onError` that only
 *     restored the data.
 *   - Edit and Submit follow the `evidence.edit` grant (`canEdit`), which a
 *     custom role on a write-tier base can lack.
 *
 * Same seams as evidence-ep2: next-intl resolves en.json, SWR is a fixture.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

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

jest.mock('next-intl', () => {
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

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

// Keyed by path so the file-versions read can answer differently from the
// record read.
const swr: { detail: { data: unknown; isLoading: boolean; error: unknown }; versions: unknown } = {
    detail: { data: undefined, isLoading: false, error: undefined },
    versions: undefined,
};
const mutateDetail = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key && key.endsWith('/file-versions')) return { data: swr.versions };
        return { ...swr.detail, mutate: mutateDetail };
    },
}));

jest.mock('@/components/ui/copy-text', () => ({
    CopyText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

jest.mock('@/components/LinkedTasksPanel', () => ({ __esModule: true, default: () => null }));

// The undo toast commits at once, so a test does not wait out its window.
const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useToast: () => ({ error: toastError, success: jest.fn(), info: jest.fn() }),
        useToastWithUndo: () => (input: { action: () => Promise<unknown>; onError?: (e: unknown) => void }) => {
            void input.action().catch((e) => input.onError?.(e));
            return 'toast';
        },
    };
});

import { EvidenceDetailSheet } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet';

const EN = require('../../messages/en.json');
const SHA = 'b'.repeat(64);

function fileEvidence(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ev_1',
        title: 'Quarterly access review',
        content: null,
        type: 'FILE',
        status: 'DRAFT',
        fileName: 'review.png',
        fileSize: 1024,
        fileRecordId: 'fr_1',
        nextReviewDate: null,
        retentionUntil: null,
        expiredAt: null,
        isArchived: false,
        reviewCycle: null,
        owner: null,
        ownerUserId: null,
        category: null,
        folder: null,
        evidenceControlLinks: [] as unknown[],
        taskId: null,
        riskId: null,
        assetId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
        fileRecord: {
            id: 'fr_1',
            originalName: 'review.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
            sha256: SHA,
            retentionUntil: null,
            scanStatus: 'CLEAN',
        },
        reviews: [],
        ...overrides,
    };
}

const LINKED = [
    { id: 'l1', controlId: 'c1', control: { id: 'c1', name: 'Access control', annexId: 'A.5.15', code: null } },
];

function renderSheet(props: Record<string, unknown> = {}) {
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

beforeEach(() => {
    swr.detail = { data: undefined, isLoading: false, error: undefined };
    swr.versions = undefined;
    mutateDetail.mockReset();
    toastError.mockReset();
});

describe('a failed load shows the error, not "Loading…"', () => {
    it('shows the server message when the first load fails', () => {
        swr.detail = { data: undefined, isLoading: false, error: new Error('Evidence not found') };
        renderSheet();
        expect(screen.getByTestId('evidence-sheet-error')).toHaveTextContent('Evidence not found');
        expect(screen.queryByText(EN.evidence.detail.loadingBody)).toBeNull();
    });

    it('still shows "Loading…" while the first load is in flight', () => {
        swr.detail = { data: undefined, isLoading: true, error: undefined };
        renderSheet();
        expect(screen.getByText(EN.evidence.detail.loadingBody)).toBeInTheDocument();
    });
});

describe('download and preview follow the route\'s record gates', () => {
    it('archived evidence: no preview, no download, and the reason', () => {
        swr.detail = { data: fileEvidence({ isArchived: true, evidenceControlLinks: LINKED }), isLoading: false, error: undefined };
        renderSheet();
        expect(screen.queryByTestId('evidence-sheet-preview-image')).toBeNull();
        expect(document.getElementById('evidence-sheet-download-btn')).toBeNull();
        expect(document.getElementById('evidence-sheet-download-refused')).toHaveTextContent(
            EN.evidence.detail.downloadArchived,
        );
    });

    it('a read-tier viewer on evidence linked to no control: no preview, no download, and the reason', () => {
        swr.detail = { data: fileEvidence(), isLoading: false, error: undefined };
        renderSheet({ canWrite: false, canAdmin: false });
        expect(screen.queryByTestId('evidence-sheet-preview-image')).toBeNull();
        expect(document.getElementById('evidence-sheet-download-btn')).toBeNull();
        expect(document.getElementById('evidence-sheet-download-refused')).toHaveTextContent(
            EN.evidence.detail.downloadNeedsControl,
        );
    });

    it('the same viewer keeps both once the evidence is linked to a control', () => {
        swr.detail = { data: fileEvidence({ evidenceControlLinks: LINKED }), isLoading: false, error: undefined };
        renderSheet({ canWrite: false, canAdmin: false });
        expect(screen.getByTestId('evidence-sheet-preview-image')).toBeInTheDocument();
        expect(document.getElementById('evidence-sheet-download-btn')).not.toBeNull();
        expect(document.getElementById('evidence-sheet-download-refused')).toBeNull();
    });

    it('an older version is not offered for download on archived evidence', () => {
        swr.detail = { data: fileEvidence({ isArchived: true }), isLoading: false, error: undefined };
        swr.versions = {
            fileVersion: 2,
            versions: [
                { id: 'fr_1', version: 2, originalName: 'review.png', mimeType: 'image/png', sizeBytes: 1, sha256: SHA, createdAt: '2026-06-02T00:00:00.000Z', isCurrent: true },
                { id: 'fr_0', version: 1, originalName: 'old.png', mimeType: 'image/png', sizeBytes: 1, sha256: SHA, createdAt: '2026-06-01T00:00:00.000Z', isCurrent: false },
            ],
        };
        renderSheet();
        expect(screen.getByTestId('evidence-file-version-1')).toBeInTheDocument();
        expect(document.getElementById('evidence-version-download-1')).toBeNull();
    });
});

describe('a failed unlink is reported', () => {
    it('restores the control and shows the server reason', async () => {
        swr.detail = { data: fileEvidence({ evidenceControlLinks: LINKED }), isLoading: false, error: undefined };
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: { code: 'FORBIDDEN', message: 'You do not have permission to edit evidence.' } }),
        })) as unknown as typeof fetch;
        renderSheet();
        await act(async () => {
            fireEvent.click(document.getElementById('unlink-control-c1')!);
        });
        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith('You do not have permission to edit evidence.'),
        );
        // The optimistic removal is rolled back to the record as it was.
        const restores = mutateDetail.mock.calls.filter(
            ([v]) => v && typeof v === 'object' && (v as { evidenceControlLinks?: unknown[] }).evidenceControlLinks?.length === 1,
        );
        expect(restores.length).toBeGreaterThan(0);
    });
});

describe('Edit and Submit follow the evidence.edit grant', () => {
    it('hides both when canEdit is false, even with the write tier', () => {
        swr.detail = { data: fileEvidence(), isLoading: false, error: undefined };
        renderSheet({ canWrite: true, canEdit: false, canAdmin: false });
        expect(document.getElementById('evidence-sheet-edit-btn')).toBeNull();
        expect(document.getElementById('evidence-sheet-submit-btn')).toBeNull();
        // Linking a control follows controls.edit, not evidence.edit, so it stays.
        expect(document.getElementById('evidence-link-control-btn')).not.toBeNull();
    });

    it('shows both when canEdit is true', () => {
        swr.detail = { data: fileEvidence(), isLoading: false, error: undefined };
        renderSheet({ canWrite: true, canEdit: true, canAdmin: false });
        expect(document.getElementById('evidence-sheet-edit-btn')).not.toBeNull();
        expect(document.getElementById('evidence-sheet-submit-btn')).not.toBeNull();
    });
});

describe('the inline preview is asked for as a preview', () => {
    it('the image loads with ?purpose=preview; the Download button is a plain download', () => {
        swr.detail = { data: fileEvidence({ evidenceControlLinks: LINKED }), isLoading: false, error: undefined };
        renderSheet();
        const img = screen.getByTestId('evidence-sheet-preview-image') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe('/api/t/acme/evidence/files/fr_1/download?purpose=preview');
        expect(document.getElementById('evidence-sheet-download-btn')!.getAttribute('href')).toBe(
            '/api/t/acme/evidence/files/fr_1/download',
        );
    });
});
