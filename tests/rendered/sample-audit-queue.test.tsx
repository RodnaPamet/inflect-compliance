/**
 * THE SAMPLE-AUDIT ANSWERING SECTION (OWASP ASI09).
 *
 * `recordSampleAuditOutcome` refuses an answer five ways. This panel is where a
 * reviewer meets all five, and the split between them is the thing to hold:
 *
 *   THREE ARE THE SERVER'S VERDICT, arriving per row as `refusal`. The panel
 *   renders the reason and NO control. It must never render a disabled button
 *   that posts and fails, and must never compute the verdict itself — the
 *   hardest of them reads the proposal's approvers, which never reach the
 *   browser.
 *
 *   TWO ARE THE FORM'S OWN SHAPE — DISSENTED needs a code, everything else
 *   needs none. Both are asserted here as the difference between a submit that
 *   works and one that does not, and the codes are proven to leave the request
 *   entirely when the outcome moves off DISSENTED.
 *
 *   AND ONE IS NOT HELD HERE AT ALL: the race. Somebody else answering between
 *   this render and this click is settled by the server's conditional claim on
 *   `outcome: 'PENDING'`, and the last test asserts the panel treats that
 *   refusal as somebody's answer rather than as a retryable failure.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    useToast: () => ({ success: toastSuccess, error: jest.fn(), info: jest.fn(), warning: jest.fn() }),
}));

import { SampleAuditQueue, type SampleAuditQueueRow } from '@/app/t/[tenantSlug]/(app)/agents/review-quality/SampleAuditQueue';

const OUTCOMES = ['CONCURRED', 'DISSENTED', 'INDETERMINATE'];
const CODES = [
    'RATIONALE_DOES_NOT_SUPPORT_PAYLOAD',
    'MATERIALLY_INACCURATE',
    'DUPLICATE_OF_EXISTING_RECORD',
    'WRONG_ENTITY_KIND',
    'SHOULD_HAVE_BEEN_EDITED',
    'SHOULD_HAVE_BEEN_REJECTED',
    'OUTSIDE_AGENT_REMIT',
];

const row = (over: Partial<SampleAuditQueueRow> = {}): SampleAuditQueueRow => ({
    id: 'sa1',
    agentLabel: 'Risk drafter',
    kindLabel: 'Risk',
    sampledAt: '2026-11-10T09:00:00.000Z',
    approvedAt: '2026-11-08T09:00:00.000Z',
    refusal: null,
    ...over,
});

function mount(rows: SampleAuditQueueRow[]) {
    return render(
        <SampleAuditQueue rows={rows} outcomes={OUTCOMES} dissentCodes={CODES} />,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

describe('refusals the server computed', () => {
    it.each([
        ['SELF_REVIEW', 'You approved this proposal, so somebody else answers its audit.'],
        ['ALREADY_ANSWERED', 'Already answered.'],
        ['NOT_A_WRITER', 'You can read this queue but not answer it.'],
    ] as const)('%s renders its reason and NO answer control', (refusal, reason) => {
        mount([row({ refusal })]);
        expect(screen.getByTestId('sample-audit-refusal-sa1')).toHaveTextContent(reason);
        // Not a disabled button — no button at all. A control that exists to be
        // refused teaches a reviewer the refusal is a bug.
        expect(screen.queryByTestId('sample-audit-answer-sa1')).toBeNull();
    });

    it('offers the control when the server says the viewer may answer', () => {
        mount([row()]);
        expect(screen.getByTestId('sample-audit-answer-sa1')).toBeInTheDocument();
        expect(screen.queryByTestId('sample-audit-refusal-sa1')).toBeNull();
    });

    it('shows the row context a reviewer needs to know what they are re-reading', () => {
        mount([row()]);
        const card = screen.getByTestId('sample-audit-sa1');
        expect(card).toHaveTextContent('Risk');
        expect(card).toHaveTextContent('Risk drafter');
    });

    it('says so when nothing is waiting, rather than rendering an empty list', () => {
        mount([]);
        expect(screen.getByTestId('sample-audit-queue-empty')).toBeInTheDocument();
    });
});

describe('the outcome/codes pairing', () => {
    function openForm() {
        mount([row()]);
        fireEvent.click(screen.getByTestId('sample-audit-answer-sa1'));
    }

    it('will not submit with no outcome chosen', () => {
        openForm();
        expect(screen.getByTestId('sample-audit-submit-sa1')).toBeDisabled();
    });

    it('offers no codes until DISSENTED is chosen', () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[0]); // CONCURRED
        expect(screen.queryByTestId('sample-audit-codes-sa1')).toBeNull();
    });

    it('will not submit DISSENTED without a code', () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[1]); // DISSENTED
        expect(screen.getByTestId('sample-audit-codes-sa1')).toBeInTheDocument();
        expect(screen.getByTestId('sample-audit-submit-sa1')).toBeDisabled();
    });

    it('submits DISSENTED with the chosen codes', async () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[1]);
        fireEvent.click(screen.getAllByRole('checkbox')[1]); // MATERIALLY_INACCURATE
        fireEvent.click(screen.getByTestId('sample-audit-submit-sa1'));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('/api/t/acme/agent-proposals/sample-audits/sa1');
        expect(JSON.parse(init.body)).toEqual({
            outcome: 'DISSENTED',
            dissentCodes: ['MATERIALLY_INACCURATE'],
        });
    });

    it('sends NO dissentCodes key on a non-DISSENTED answer', async () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[0]); // CONCURRED
        fireEvent.click(screen.getByTestId('sample-audit-submit-sa1'));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(body).toEqual({ outcome: 'CONCURRED' });
        expect('dissentCodes' in body).toBe(false);
    });

    it('builds no dissentCodes key after a DISSENTED selection is abandoned', async () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[1]); // DISSENTED
        fireEvent.click(screen.getAllByRole('checkbox')[0]);
        fireEvent.click(screen.getAllByRole('radio')[2]); // INDETERMINATE
        fireEvent.click(screen.getByTestId('sample-audit-submit-sa1'));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        // The server refuses codes on a non-DISSENTED outcome (400). The
        // request BUILDER is the thing proven here: it keys off the outcome, so
        // such a body cannot be assembled whatever the code state holds.
        expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
            outcome: 'INDETERMINATE',
        });
    });

    it('clears the codes themselves, so returning to DISSENTED starts empty', () => {
        // The SECOND line of defence, and the only one a reviewer can see. The
        // builder above makes an abandoned code unsendable; this makes it
        // un-chosen, so coming back to DISSENTED cannot submit on a code the
        // reviewer walked away from and never saw again.
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[1]); // DISSENTED
        fireEvent.click(screen.getAllByRole('checkbox')[0]);
        expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
        fireEvent.click(screen.getAllByRole('radio')[2]); // INDETERMINATE
        fireEvent.click(screen.getAllByRole('radio')[1]); // back to DISSENTED
        expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
        expect(screen.getByTestId('sample-audit-submit-sa1')).toBeDisabled();
    });

    it('records the answer, clears the row and re-reads the page', async () => {
        openForm();
        fireEvent.click(screen.getAllByRole('radio')[0]);
        fireEvent.click(screen.getByTestId('sample-audit-submit-sa1'));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        expect(screen.queryByTestId('sample-audit-sa1')).toBeNull();
        // THE NUMBER is server-read, so an answer that does not re-read leaves
        // the rate on this page describing the moment before the click.
        expect(refresh).toHaveBeenCalled();
    });
});

describe('the race the server settles', () => {
    it('reports the refusal and KEEPS the row, because a failure is not an answer', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ error: 'Sample audit is already CONCURRED' }),
        }) as never;
        mount([row()]);
        fireEvent.click(screen.getByTestId('sample-audit-answer-sa1'));
        fireEvent.click(screen.getAllByRole('radio')[0]);
        fireEvent.click(screen.getByTestId('sample-audit-submit-sa1'));
        await screen.findByText('Sample audit is already CONCURRED');
        // Still listed: the panel does not guess that a failure means answered.
        // Only a success clears the row, because only a success is one.
        expect(screen.getByTestId('sample-audit-sa1')).toBeInTheDocument();
        expect(refresh).not.toHaveBeenCalled();
    });
});
