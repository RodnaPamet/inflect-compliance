/**
 * A text note's body is labelled as the create form labels it (#5764).
 *
 * The details panel labelled a note's text "Description" and, since the
 * evidence gained its own Description field, also showed that field as
 * "Description" — two rows of one name holding different things. The edit
 * form did the same. The create form has always called the note's text
 * "Content"; the panel and the edit form now say so too, and a link's body
 * is its address.
 */
import { render, screen, within } from '@testing-library/react';
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

function textEvidence(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ev_1',
        title: 'Access review note',
        content: 'Reviewed every admin account on 1 June.',
        description: 'Shows the quarterly review was done.',
        type: 'TEXT',
        status: 'DRAFT',
        fileName: null,
        fileSize: null,
        fileRecordId: null,
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
        fileRecord: null,
        reviews: [],
        ...overrides,
    };
}

function renderSheet() {
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
        />,
    );
}

beforeEach(() => {
    swr.versions = undefined;
    mutateDetail.mockReset();
    toastError.mockReset();
});

describe('the details panel labels a note\'s text "Content", not a second "Description"', () => {
    it('a text note: its text under the create form\'s label, its Description once', () => {
        swr.detail = { data: textEvidence(), isLoading: false, error: undefined };
        renderSheet();

        expect(screen.getByTestId('evidence-sheet-content-label')).toHaveTextContent(EN.evidence.text.contentLabel);
        expect(screen.getByTestId('evidence-sheet-content')).toHaveTextContent('Reviewed every admin account on 1 June.');
        expect(screen.getByTestId('evidence-detail-description')).toHaveTextContent('Shows the quarterly review was done.');
        // "Description" names the evidence's own Description row and nothing else.
        expect(screen.getAllByText(EN.evidence.detail.metaDescription)).toHaveLength(1);
    });

    it('a link: its address under the edit form\'s address label', () => {
        swr.detail = {
            data: textEvidence({ type: 'LINK', content: 'https://example.test/report' }),
            isLoading: false,
            error: undefined,
        };
        renderSheet();

        const label = screen.getByTestId('evidence-sheet-content-label');
        expect(label).toHaveTextContent(EN.evidence.edit.addressLabel);
        expect(within(label.parentElement as HTMLElement).getByRole('link')).toHaveAttribute(
            'href',
            'https://example.test/report',
        );
        expect(screen.getAllByText(EN.evidence.detail.metaDescription)).toHaveLength(1);
    });
});
