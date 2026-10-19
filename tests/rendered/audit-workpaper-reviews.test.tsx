/**
 * #3677 — INTERNAL AUDIT'S REVIEW PAGE FOR THE AUDITOR'S SAMPLED WORKPAPERS.
 *
 * What the page must do, each asserted where it would quietly break:
 *
 *   • list the reviewer's OWN assigned workpapers, and tell somebody outside
 *     internal audit why they see none rather than an empty queue that reads
 *     as "nothing to do";
 *   • show what the auditor agent recorded, so the reviewer can re-perform it;
 *   • take the answer as CODES: a radio group and, for a dissent, the stable
 *     dissent codes — and NO text field anywhere in the form, counted rather
 *     than described;
 *   • refuse to send a dissent with no code, and send exactly
 *     `{ outcome, dissentCodes? }` and nothing else;
 *   • offer no form at all on an answered review, which is set once;
 *   • carry no control that opens a review or picks a reviewer;
 *   • show internal audit EVERY assignment, read-only but for its own, with
 *     the answer form only on the viewer's own row (owner decision, 2026-10-19);
 *   • offer the sampling-rate control to internal audit only, and send exactly
 *     `{ samplePercent }`.
 */
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const walk = (root: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    // MEMOISED per namespace: a fresh `t` per render invalidates the column memo.
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/audits/workpaper-reviews',
    useSearchParams: () => new URLSearchParams(),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));
const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ error: toastError, success: toastSuccess }),
}));

import {
    WorkpaperReviewsClient,
    WORKPAPER_REVIEWS_ENDPOINT,
    type WorkpaperReviewListPayload,
    type WorkpaperReviewRow,
} from '@/app/t/[tenantSlug]/(app)/audits/workpaper-reviews/WorkpaperReviewsClient';
import type { WorkpaperReviewDetailPayload } from '@/app/t/[tenantSlug]/(app)/audits/workpaper-reviews/WorkpaperReviewSheet';

const EN = jest.requireActual('../../messages/en.json') as { audits: { workpaperReviews: Record<string, unknown> } };
const copy = (path: string): string => {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.audits.workpaperReviews,
    );
    if (typeof v !== 'string') throw new Error(`messages/en.json has no audits.workpaperReviews.${path}`);
    return v;
};

function row(over: Partial<WorkpaperReviewRow> = {}): WorkpaperReviewRow {
    return {
        id: 'rev-1',
        workpaperId: 'wp-1',
        samplingEpoch: 'audit-workpaper-review@2026-09',
        samplePercent: 100,
        sampledAt: '2026-10-03T09:40:00.000Z',
        assignedToUserId: 'user-me',
        unassignedReason: null,
        assignedAt: '2026-10-03T09:40:00.000Z',
        outcome: 'PENDING',
        dissentCodes: [],
        reviewedAt: null,
        findingProposalId: null,
        mine: true,
        assignee: { userId: 'user-me', name: 'Me Myself' },
        answerable: true,
        refusal: null,
        workpaper: {
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel: '2026-09',
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            populationCount: 4,
            sampleSize: 2,
            exceptionCount: 0,
            auditorAgentId: 'agent-auditor',
            createdAt: '2026-10-02T06:17:00.000Z',
        },
        ...over,
    };
}

function detail(
    over: Partial<WorkpaperReviewDetailPayload['review']> = {},
    viewer: WorkpaperReviewDetailPayload['viewer'] = {
        mine: true,
        answerable: (over.outcome ?? 'PENDING') === 'PENDING',
        refusal: (over.outcome ?? 'PENDING') === 'PENDING' ? null : 'ALREADY_REVIEWED',
    },
): WorkpaperReviewDetailPayload {
    return {
        review: {
            id: 'rev-1',
            workpaperId: 'wp-1',
            samplingEpoch: 'audit-workpaper-review@2026-09',
            samplePercent: 100,
            sampledAt: '2026-10-03T09:40:00.000Z',
            assignedToUserId: 'user-me',
            unassignedReason: null,
            outcome: 'PENDING',
            dissentCodes: [],
            reviewedAt: null,
            findingProposalId: null,
            ...over,
        },
        viewer,
        workpaper: {
            id: 'wp-1',
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel: '2026-09',
            populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
            populationCount: 4,
            populationDigest: 'b'.repeat(64),
            sampleEpoch: 'iam.leaver_timeliness@2026-09',
            seedFingerprint: 'c'.repeat(64),
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            parametersJson: { leaverWindowHours: 24 },
            attributesTested: ['L1', 'L2'],
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: 'PASS', code: null },
                { unitId: 'emp_2', outcome: 'EXCEPTION', code: 'ACCOUNT_ACTIVE_AFTER_WINDOW' },
            ],
            exceptionsJson: [{ unitId: 'emp_2', code: 'ACCOUNT_ACTIVE_AFTER_WINDOW', proposalId: 'prop-9' }],
            conclusion: 'FAIL',
            conclusionBasis: 'EXCEPTIONS_FOUND',
            evidenceRefs: ['ev-1'],
            proposalIds: ['prop-9'],
            auditorAgentId: 'agent-auditor',
            controlTestRunId: 'run-1',
            createdAt: '2026-10-02T06:17:00.000Z',
        },
        narrative: null,
    };
}

const listMutate = jest.fn();
const detailMutate = jest.fn();

type ListInput = Omit<WorkpaperReviewListPayload, 'scope' | 'sampleRate'> &
    Partial<Pick<WorkpaperReviewListPayload, 'scope' | 'sampleRate'>>;

function mockData(input: ListInput, sheet: WorkpaperReviewDetailPayload | ((key: string) => WorkpaperReviewDetailPayload) = detail()) {
    const list: WorkpaperReviewListPayload = {
        scope: 'OWN',
        sampleRate: { percent: 100, canChange: false, refusal: 'REVIEWER_LINE_NOT_THIRD' },
        ...input,
    };
    swr.mockImplementation((key: string | null) => {
        if (key === WORKPAPER_REVIEWS_ENDPOINT) return { data: list, error: undefined, isLoading: false, mutate: listMutate };
        if (key && key.startsWith(`${WORKPAPER_REVIEWS_ENDPOINT}/`)) {
            return {
                data: typeof sheet === 'function' ? sheet(key) : sheet,
                error: undefined,
                isLoading: false,
                mutate: detailMutate,
            };
        }
        return { data: undefined, error: undefined, isLoading: false, mutate: jest.fn() };
    });
}

const fetchMock = jest.fn();

beforeEach(() => {
    swr.mockReset();
    listMutate.mockReset();
    detailMutate.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(cleanup);

async function openRow(id = 'rev-1') {
    fireEvent.click(await screen.findByTestId(`workpaper-review-row-${id}`));
    return screen.findByTestId('workpaper-review-sheet');
}

describe('the queue is the reviewer’s own', () => {
    it('lists each assigned workpaper with its procedure, period and the reviewer’s state', async () => {
        mockData({
            reviewer: { eligible: true, reason: null },
            truncated: false,
            rows: [
                row(),
                row({ id: 'rev-2', outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED'], answerable: false, refusal: 'ALREADY_REVIEWED' }),
                row({ id: 'rev-3', answerable: false, refusal: 'REVIEWER_OWNS_AUDITOR' }),
            ],
        });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        expect(await screen.findByTestId('workpaper-review-row-rev-1')).toHaveTextContent('iam.leaver_timeliness');
        expect(screen.getByTestId('workpaper-reviews-table')).toHaveTextContent('2026-09');
        expect(screen.getByText(copy('outcome.PENDING'))).toBeInTheDocument();
        expect(screen.getByText(copy('outcome.DISSENTED'))).toBeInTheDocument();
        expect(screen.getByText(copy('refusal.REVIEWER_OWNS_AUDITOR'))).toBeInTheDocument();
        expect(screen.queryByTestId('workpaper-reviews-not-eligible')).not.toBeInTheDocument();
    });

    it('tells somebody outside internal audit why they see nothing, rather than an empty queue', async () => {
        mockData({ reviewer: { eligible: false, reason: 'REVIEWER_LINE_NOT_THIRD' }, truncated: false, rows: [] });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        expect(await screen.findByTestId('workpaper-reviews-not-eligible')).toHaveTextContent(copy('notEligible.REVIEWER_LINE_NOT_THIRD'));
        expect(screen.getByText(copy('emptyNotEligible'))).toBeInTheDocument();
    });

    it('offers no control that opens a review or chooses a reviewer', async () => {
        mockData({ reviewer: { eligible: true, reason: null }, truncated: false, rows: [row()] });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        await screen.findByTestId('workpaper-review-row-rev-1');
        const buttons = screen.queryAllByRole('button').map((b) => (b.textContent ?? '').trim().toLowerCase());
        for (const verb of ['draw', 'sample', 'assign', 'new', 'create']) {
            expect(buttons.some((label) => label.startsWith(verb))).toBe(false);
        }
    });
});

describe('the sheet shows the record and takes the answer as codes', () => {
    beforeEach(() => {
        mockData({ reviewer: { eligible: true, reason: null }, truncated: false, rows: [row()] });
    });

    it('shows what the auditor agent recorded: the population, the sample, each unit and the exceptions', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        expect(within(sheet).getByTestId('workpaper-review-facts')).toHaveTextContent('Employee rows with status TERMINATED');
        expect(within(sheet).getByTestId('workpaper-review-facts')).toHaveTextContent('iam.leaver_timeliness@2026-09');
        expect(within(sheet).getByTestId('workpaper-review-outcomes')).toHaveTextContent('emp_2 · EXCEPTION · ACCOUNT_ACTIVE_AFTER_WINDOW');
        expect(within(sheet).getByTestId('workpaper-review-exceptions')).toHaveTextContent('prop-9');
    });

    it('shows the auditor agent’s narrative beside the record, labelled as a summary to re-perform (#3749)', async () => {
        mockData(
            { reviewer: { eligible: true, reason: null }, truncated: false, rows: [row()] },
            {
                ...detail(),
                narrative: {
                    text: 'Two of four leavers were sampled; emp_2 stayed active after the window. FAIL.',
                    exceptionCodes: ['ACCOUNT_ACTIVE_AFTER_WINDOW'],
                    runId: 'run-narr-1',
                    createdAt: '2026-10-03T06:00:00.000Z',
                },
            },
        );
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        const section = within(sheet).getByTestId('workpaper-review-narrative');
        expect(within(section).getByTestId('workpaper-review-narrative-text')).toHaveTextContent('emp_2 stayed active after the window');
        expect(section).toHaveTextContent('re-perform the workpaper');
        expect(section).toHaveTextContent('run-narr-1');
        // It informs; it does not answer. The form is still the reviewer's.
        expect(within(sheet).getByTestId('workpaper-review-answer-form')).toBeInTheDocument();
    });

    it('says when no narrative has been drafted yet, rather than leaving a gap', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        expect(within(sheet).getByTestId('workpaper-review-narrative')).toHaveTextContent('No narrative yet');
        expect(within(sheet).queryByTestId('workpaper-review-narrative-text')).toBeNull();
    });

    it('has no free-text field anywhere in the answer form', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        const form = within(sheet).getByTestId('workpaper-review-answer-form');
        fireEvent.click(within(form).getByTestId('workpaper-review-outcome-DISSENTED'));
        // Counted, with the dissent codes on screen: a radio group and a picker
        // over the stable vocabulary, and nothing anyone could type a note into.
        expect(form.querySelectorAll('textarea')).toHaveLength(0);
        expect(form.querySelectorAll('input[type="text"], input:not([type]), [contenteditable="true"]')).toHaveLength(0);
        expect(within(form).getAllByRole('radio')).toHaveLength(3);
        expect(within(form).getByRole('combobox')).toBeInTheDocument();
    });

    it('sends exactly { outcome } for a concurrence, and refreshes the queue', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'rev-1', outcome: 'CONCURRED' }) });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        const submit = within(sheet).getByRole('button', { name: copy('recordAnswer') });
        expect(submit).toBeDisabled();
        fireEvent.click(within(sheet).getByTestId('workpaper-review-outcome-CONCURRED'));
        expect(submit).toBeEnabled();
        fireEvent.click(submit);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
        expect(url).toBe('/api/t/acme/audits/workpaper-reviews/rev-1');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ outcome: 'CONCURRED' });
        await waitFor(() => expect(listMutate).toHaveBeenCalled());
        expect(toastSuccess).toHaveBeenCalledWith(copy('answered'));
    });

    it('will not send a dissent with no code, and sends the codes chosen', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'rev-1', outcome: 'DISSENTED' }) });
        const user = userEvent.setup();
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        const submit = within(sheet).getByRole('button', { name: copy('recordAnswer') });
        await user.click(within(sheet).getByTestId('workpaper-review-outcome-DISSENTED'));
        expect(submit).toBeDisabled();

        await user.click(within(sheet).getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: copy('codes.EXCEPTION_MISSED') }));
        await waitFor(() => expect(submit).toBeEnabled());
        await user.click(submit);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
        expect(JSON.parse(init.body)).toEqual({ outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED'] });
        expect(toastSuccess).toHaveBeenCalledWith(copy('answeredDissent'));
    });

    it('shows the server’s refusal inline and does not pretend it landed', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            json: async () => ({ error: { message: 'The owner of the auditor agent never reviews its workpapers.' } }),
        });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        fireEvent.click(within(sheet).getByTestId('workpaper-review-outcome-INDETERMINATE'));
        fireEvent.click(within(sheet).getByRole('button', { name: copy('recordAnswer') }));
        expect(await within(sheet).findByTestId('workpaper-review-answer-error')).toHaveTextContent(
            'The owner of the auditor agent never reviews its workpapers.',
        );
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(listMutate).not.toHaveBeenCalled();
    });

    it('offers no form on an answered review — the answer is set once', async () => {
        mockData(
            { reviewer: { eligible: true, reason: null }, truncated: false, rows: [row({ outcome: 'DISSENTED', answerable: false, refusal: 'ALREADY_REVIEWED' })] },
            detail({ outcome: 'DISSENTED', dissentCodes: ['CONCLUSION_NOT_SUPPORTED'], reviewedAt: '2026-10-05T10:00:00.000Z', findingProposalId: 'prop-42' }),
        );
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow();
        expect(within(sheet).queryByTestId('workpaper-review-answer-form')).not.toBeInTheDocument();
        expect(within(sheet).queryByRole('radio')).not.toBeInTheDocument();
        const recorded = within(sheet).getByTestId('workpaper-review-recorded');
        expect(recorded).toHaveTextContent(copy('codes.CONCLUSION_NOT_SUPPORTED'));
        expect(recorded).toHaveTextContent('prop-42');
    });
});

describe('internal audit sees every assignment, and answers only its own (owner decision, 2026-10-19)', () => {
    const overviewRows = [
        row(),
        row({
            id: 'rev-2',
            workpaperId: 'wp-2',
            assignedToUserId: 'user-other',
            mine: false,
            assignee: { userId: 'user-other', name: 'Olga Other' },
            answerable: false,
            refusal: 'NOT_ASSIGNED_REVIEWER',
        }),
        row({
            id: 'rev-3',
            workpaperId: 'wp-3',
            assignedToUserId: null,
            unassignedReason: 'NO_THIRD_LINE_MEMBER',
            mine: false,
            assignee: null,
            answerable: false,
            refusal: 'UNASSIGNED',
        }),
    ];
    const sheetFor = (key: string) =>
        key.endsWith('/rev-2')
            ? detail({ id: 'rev-2', workpaperId: 'wp-2', assignedToUserId: 'user-other' }, { mine: false, answerable: false, refusal: 'NOT_ASSIGNED_REVIEWER' })
            : key.endsWith('/rev-3')
              ? detail(
                    { id: 'rev-3', workpaperId: 'wp-3', assignedToUserId: null, unassignedReason: 'NO_THIRD_LINE_MEMBER' },
                    { mine: false, answerable: false, refusal: 'UNASSIGNED' },
                )
              : detail();

    beforeEach(() => {
        mockData(
            {
                reviewer: { eligible: true, reason: null },
                scope: 'ALL',
                sampleRate: { percent: 100, canChange: true, refusal: null },
                truncated: false,
                rows: overviewRows,
            },
            sheetFor,
        );
    });

    it('lists other reviewers’ rows, with who each is assigned to and its status', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        expect(await screen.findByTestId('workpaper-reviews-overview')).toHaveTextContent(copy('overview'));
        expect(screen.getByTestId('workpaper-review-assignee-rev-1')).toHaveTextContent(copy('assigneeYou'));
        expect(screen.getByTestId('workpaper-review-assignee-rev-2')).toHaveTextContent('Olga Other');
        expect(screen.getByTestId('workpaper-review-assignee-rev-3')).toHaveTextContent(copy('assigneeNobody'));
        expect(screen.getByText(copy('awaitingReviewer'))).toBeInTheDocument();
        expect(screen.getByText(copy('refusal.UNASSIGNED'))).toBeInTheDocument();
        // Only the viewer's own unanswered row counts as awaiting THEIR answer.
        expect(screen.getByText(copy('outcome.PENDING'))).toBeInTheDocument();
    });

    it('opens somebody else’s row read-only — no form, no radio, no answer button', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow('rev-2');
        expect(within(sheet).getByTestId('workpaper-review-facts')).toBeInTheDocument();
        expect(within(sheet).queryByTestId('workpaper-review-answer-form')).not.toBeInTheDocument();
        expect(within(sheet).queryByRole('radio')).not.toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: copy('recordAnswer') })).not.toBeInTheDocument();
        expect(within(sheet).getByTestId('workpaper-review-read-only')).toHaveTextContent(copy('readOnlyOther'));
    });

    it('opens an UNASSIGNED row read-only and says why nobody has it', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow('rev-3');
        expect(within(sheet).queryByTestId('workpaper-review-answer-form')).not.toBeInTheDocument();
        expect(within(sheet).getByTestId('workpaper-review-read-only')).toHaveTextContent('NO_THIRD_LINE_MEMBER');
    });

    it('shows the answer form on the viewer’s own row', async () => {
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const sheet = await openRow('rev-1');
        expect(within(sheet).getByTestId('workpaper-review-answer-form')).toBeInTheDocument();
        expect(within(sheet).getAllByRole('radio')).toHaveLength(3);
    });
});

describe('the sampling rate is internal audit’s to set (owner decision, 2026-10-19)', () => {
    it('offers the control to internal audit and sends exactly { samplePercent }', async () => {
        mockData({
            reviewer: { eligible: true, reason: null },
            scope: 'ALL',
            sampleRate: { percent: 100, canChange: true, refusal: null },
            truncated: false,
            rows: [row()],
        });
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ samplePercent: 99, previous: 100, changed: true }) });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const control = await screen.findByTestId('workpaper-review-sample-rate');
        const save = within(control).getByRole('button', { name: copy('rateSave') });
        // Nothing to save until the value moves.
        expect(save).toBeDisabled();
        fireEvent.click(within(control).getByRole('button', { name: copy('rateDecrease') }));
        expect(save).toBeEnabled();
        fireEvent.click(save);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
        expect(url).toBe('/api/t/acme/audits/workpaper-reviews/sample-rate');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ samplePercent: 99 });
        await waitFor(() => expect(listMutate).toHaveBeenCalled());
    });

    it('shows the server’s refusal inline', async () => {
        mockData({
            reviewer: { eligible: true, reason: null },
            scope: 'ALL',
            sampleRate: { percent: 100, canChange: true, refusal: null },
            truncated: false,
            rows: [row()],
        });
        fetchMock.mockResolvedValue({
            ok: false,
            json: async () => ({ error: { message: 'The owner of the auditor agent never sets how closely internal audit checks it.' } }),
        });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        const control = await screen.findByTestId('workpaper-review-sample-rate');
        fireEvent.click(within(control).getByRole('button', { name: copy('rateDecrease') }));
        fireEvent.click(within(control).getByRole('button', { name: copy('rateSave') }));
        expect(await within(control).findByTestId('workpaper-review-sample-rate-error')).toHaveTextContent(
            'The owner of the auditor agent never sets',
        );
        expect(listMutate).not.toHaveBeenCalled();
    });

    it('offers no control to anybody else — the auditor’s owner on the third line included', async () => {
        mockData({
            reviewer: { eligible: true, reason: null },
            scope: 'OWN',
            sampleRate: { percent: 100, canChange: false, refusal: 'REVIEWER_OWNS_AUDITOR' },
            truncated: false,
            rows: [row({ answerable: false, refusal: 'REVIEWER_OWNS_AUDITOR' })],
        });
        render(<WorkpaperReviewsClient tenantSlug="acme" />);
        await screen.findByTestId('workpaper-review-row-rev-1');
        expect(screen.queryByTestId('workpaper-review-sample-rate')).not.toBeInTheDocument();
        expect(screen.queryByTestId('workpaper-reviews-overview')).not.toBeInTheDocument();
        expect(screen.queryByTestId('workpaper-review-assignee-rev-1')).not.toBeInTheDocument();
    });
});
