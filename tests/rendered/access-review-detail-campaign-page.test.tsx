/**
 * The access-review campaign page (#4130), rendered with the real English
 * messages so what is asserted is what a reader sees.
 *
 *   - Nobody is offered the decide or discard control on their own row, and
 *     the row says why — the server refuses it by name.
 *   - Statuses, roles and verdicts read as labels, never as raw values.
 *   - A refused request shows the server's message, not its JSON envelope.
 *   - The Modify dialog submits the role it shows.
 *   - Every decision's justification is shown, and a connected verdict can
 *     carry one.
 *   - An Owner/Admin can change an open campaign's reviewer and due date.
 *   - A closed member campaign whose PDF failed says so, and an Owner/Admin
 *     can produce it again.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/access-reviews/rev_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            let s = String(resolve(key) ?? key);
            let prev: string;
            do {
                prev = s;
                s = s.replace(/<[^<>]*>/g, '');
            } while (s !== prev);
            return s;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: ({ onChange }: { onChange: (id: string | null) => void }) => (
        <button type="button" data-testid="pick-new-reviewer" onClick={() => onChange('usr_new_reviewer')}>
            pick
        </button>
    ),
}));

const NEW_DUE = new Date('2026-12-01T00:00:00.000Z');
jest.mock('@/components/ui/date-picker/date-picker', () => ({
    DatePicker: ({ onChange }: { onChange: (v: Date | null) => void }) => (
        <button type="button" data-testid="pick-new-due" onClick={() => onChange(NEW_DUE)}>
            due
        </button>
    ),
}));

import { AccessReviewDetailClient } from '@/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient';

const fetchMock = jest.fn();

function decision(id: string, subject: string, role: 'EDITOR' | 'READER', over: Record<string, unknown> = {}) {
    return {
        id,
        subjectUserId: subject,
        subjectUser: { id: subject, email: `${subject}@example.test`, name: subject },
        snapshotRole: role,
        snapshotMembershipStatus: 'ACTIVE',
        decision: null,
        decidedAt: null,
        decidedBy: null,
        notes: null,
        modifiedToRole: null,
        executedAt: null,
        membership: { id: `mem_${id}`, role, status: 'ACTIVE' },
        ...over,
    };
}

function makeReview(over: Record<string, unknown> = {}) {
    return {
        id: 'rev_1',
        name: 'Q4 access review',
        description: null,
        scope: 'ALL_USERS',
        status: 'IN_REVIEW',
        periodStartAt: null,
        periodEndAt: null,
        dueAt: new Date('2026-11-01T00:00:00.000Z').toISOString(),
        closedAt: null,
        createdAt: new Date('2026-10-01T00:00:00.000Z').toISOString(),
        reviewerUserId: 'usr_reviewer',
        evidenceFileRecordId: null,
        reviewer: { id: 'usr_reviewer', email: 'reviewer@example.test', name: null },
        createdBy: { id: 'usr_admin', email: 'admin@example.test', name: null },
        closedBy: null,
        decisions: [decision('dec_alice', 'usr_alice', 'EDITOR'), decision('dec_bob', 'usr_bob', 'READER')],
        connectedDecisions: [],
        snapshotTruncated: false,
        lastActivityByUser: {},
        ...over,
    };
}

type ReviewOverrides = Record<string, unknown>;

function renderPage(
    review: ReviewOverrides = {},
    props: { currentUserId?: string; isAdmin?: boolean; canManage?: boolean; canRegenerateEvidence?: boolean } = {},
) {
    const initial = makeReview(review);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return { ok: true, json: async () => initial };
        return { ok: true, status: 200, json: async () => ({}) };
    });
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, revalidateOnMount: false }}>
            <AccessReviewDetailClient
                tenantSlug="acme"
                initialReview={initial as never}
                currentUserId={props.currentUserId ?? 'usr_admin'}
                isAdmin={props.isAdmin ?? true}
                canManage={props.canManage}
                canRegenerateEvidence={props.canRegenerateEvidence}
            />
        </SWRConfig>,
    );
}

function writes(method: string) {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
}

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

describe('nobody is offered a decision on their own access', () => {
    it('an admin sees no decide control on their own row, and is told why; other rows are decidable', () => {
        renderPage({}, { currentUserId: 'usr_alice', isAdmin: true });
        expect(screen.queryByTestId('decision-select-dec_alice')).toBeNull();
        expect(screen.getByTestId('own-row-cannot-decide-dec_alice').textContent).toBe(
            'Your own access — someone else decides it',
        );
        expect(screen.getByTestId('decision-select-dec_bob')).toBeInTheDocument();
    });

    it('the assigned reviewer sees no Discard on a verdict somebody else recorded on them', () => {
        renderPage(
            {
                decisions: [
                    decision('dec_rev', 'usr_reviewer', 'EDITOR', {
                        decision: 'CONFIRM',
                        decidedBy: { id: 'usr_admin', email: 'admin@example.test', name: null },
                    }),
                    decision('dec_bob', 'usr_bob', 'READER', { decision: 'REVOKE' }),
                ],
            },
            { currentUserId: 'usr_reviewer', isAdmin: false },
        );
        expect(screen.queryByTestId('undo-decision-dec_rev')).toBeNull();
        expect(screen.getByTestId('own-row-cannot-decide-dec_rev')).toBeInTheDocument();
        expect(screen.getByTestId('undo-decision-dec_bob')).toBeInTheDocument();
    });
});

describe('labels, not raw values', () => {
    it('the status, the roles and the verdicts read as words', () => {
        renderPage({
            decisions: [
                decision('dec_alice', 'usr_alice', 'EDITOR', { decision: 'CONFIRM' }),
                decision('dec_bob', 'usr_bob', 'READER', { decision: 'MODIFY', modifiedToRole: 'AUDITOR' }),
            ],
        });
        const main = screen.getByTestId('access-review-roster-table');
        expect(within(main).getByText('Confirmed')).toBeInTheDocument();
        expect(within(main).getByText('Modified → Auditor')).toBeInTheDocument();
        expect(within(main).getAllByText('Editor').length).toBeGreaterThan(0);
        expect(within(main).queryByText('CONFIRM')).toBeNull();
        expect(within(main).queryByText('EDITOR')).toBeNull();
        expect(screen.getAllByText('In review').length).toBeGreaterThan(0);
        expect(screen.queryByText('IN_REVIEW')).toBeNull();
    });
});

describe('the Modify dialog submits the role it shows', () => {
    it('for a Reader, the first role offered is selected AND sent — never a silent READER', async () => {
        renderPage();
        fireEvent.change(screen.getByTestId('decision-select-dec_bob'), { target: { value: 'MODIFY' } });
        const picker = screen.getByTestId('decision-modal-modified-to-role') as HTMLSelectElement;
        const offered = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
        expect(offered).not.toContain('READER');
        expect(picker.value).toBe(offered[0]);
        fireEvent.click(screen.getByTestId('decision-modal-submit'));
        await waitFor(() => expect(writes('PUT')).toHaveLength(1));
        const body = JSON.parse(String((writes('PUT')[0][1] as RequestInit).body));
        expect(body).toMatchObject({ decision: 'MODIFY', modifiedToRole: offered[0] });
    });
});

describe('a refused request shows the server’s message, not its JSON', () => {
    const REFUSAL = 'CAMPAIGN_SUBJECT_MAY_NOT_DECIDE_OWN_ACCESS: Nobody records, changes or discards the decision on their own access.';

    function refuseWrites() {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (!init?.method || init.method === 'GET') return { ok: true, json: async () => makeReview() };
            return {
                ok: false,
                status: 403,
                json: async () => ({ error: { code: 'FORBIDDEN', message: REFUSAL, requestId: 'req-1' } }),
                text: async () => JSON.stringify({ error: { code: 'FORBIDDEN', message: REFUSAL, requestId: 'req-1' } }),
            };
        });
    }

    it('in the decision dialog', async () => {
        renderPage();
        refuseWrites();
        fireEvent.change(screen.getByTestId('decision-select-dec_bob'), { target: { value: 'CONFIRM' } });
        fireEvent.click(screen.getByTestId('decision-modal-submit'));
        await waitFor(() => expect(screen.getByTestId('decision-modal-error').textContent).toBe(REFUSAL));
    });

    it('in the discard dialog', async () => {
        renderPage({ decisions: [decision('dec_bob', 'usr_bob', 'READER', { decision: 'CONFIRM' })] });
        refuseWrites();
        fireEvent.click(screen.getByTestId('undo-decision-dec_bob'));
        fireEvent.change(screen.getByTestId('undo-modal-reason'), { target: { value: 'wrong person' } });
        fireEvent.click(screen.getByTestId('undo-modal-submit'));
        await waitFor(() => expect(screen.getByTestId('undo-modal-error').textContent).toBe(REFUSAL));
    });

    it('in the close dialog', async () => {
        renderPage({
            decisions: [
                decision('dec_alice', 'usr_alice', 'EDITOR', { decision: 'CONFIRM' }),
                decision('dec_bob', 'usr_bob', 'READER', { decision: 'CONFIRM' }),
            ],
        });
        refuseWrites();
        fireEvent.click(screen.getByTestId('access-review-close-button'));
        fireEvent.click(screen.getByTestId('close-modal-submit'));
        await waitFor(() => expect(screen.getByTestId('close-modal-error').textContent).toBe(REFUSAL));
    });
});

describe('justifications', () => {
    it('each member decision’s notes are shown', () => {
        renderPage({
            decisions: [
                decision('dec_alice', 'usr_alice', 'EDITOR', { decision: 'CONFIRM', notes: 'Runs payroll' }),
                decision('dec_bob', 'usr_bob', 'READER'),
            ],
        });
        expect(screen.getByTestId('decision-notes-dec_alice').textContent).toBe('Runs payroll');
        expect(screen.getByTestId('decision-notes-dec_bob').textContent).toBe('—');
    });

    it('a connected verdict goes through a dialog that collects one, and shows it', async () => {
        const connected = {
            id: 'cdec_1',
            subjectRef: 'conn-1:ext-a',
            decision: null,
            decidedAt: null,
            decidedBy: null,
            notes: null,
            executedAt: null,
            snapshotJson: { provider: 'okta', email: 'carol@example.test', displayName: 'Carol', isAdmin: false, mfaEnrolled: true, hr: null },
        };
        renderPage({
            scope: 'CONNECTED_APP',
            decisions: [],
            connectedDecisions: [connected, { ...connected, id: 'cdec_2', decision: 'REVOKE', notes: 'Contractor left' }],
        });
        expect(screen.getByTestId('decision-notes-cdec_2').textContent).toBe('Contractor left');

        fireEvent.change(screen.getByTestId('connected-decision-select-cdec_1'), { target: { value: 'REVOKE' } });
        // A connected account has no tenant role: no role picker.
        expect(screen.queryByTestId('decision-modal-modified-to-role')).toBeNull();
        fireEvent.change(screen.getByTestId('decision-modal-notes'), { target: { value: 'No longer employed' } });
        fireEvent.click(screen.getByTestId('decision-modal-submit'));
        await waitFor(() => expect(writes('POST')).toHaveLength(1));
        const [url, init] = writes('POST')[0];
        expect(url).toBe('/api/t/acme/access-reviews/rev_1/connected-decisions/cdec_1');
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({ decision: 'REVOKE', notes: 'No longer employed' });
    });
});

describe('changing an open campaign’s reviewer and due date', () => {
    it('an Owner/Admin changes both; only what changed is sent', async () => {
        renderPage({}, { canManage: true });
        fireEvent.click(screen.getByTestId('access-review-change-reviewer'));
        fireEvent.click(screen.getByTestId('pick-new-reviewer'));
        fireEvent.click(screen.getByTestId('pick-new-due'));
        fireEvent.click(screen.getByTestId('access-review-settings-save'));
        await waitFor(() => expect(writes('PATCH')).toHaveLength(1));
        const [url, init] = writes('PATCH')[0];
        expect(url).toBe('/api/t/acme/access-reviews/rev_1');
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            reviewerUserId: 'usr_new_reviewer',
            dueAt: NEW_DUE.toISOString(),
        });
    });

    it('is not offered to a non-manager, on a closed campaign, or on an agent recertification', () => {
        const r1 = renderPage({}, { isAdmin: false, canManage: false, currentUserId: 'usr_reviewer' });
        expect(screen.queryByTestId('access-review-change-reviewer')).toBeNull();
        expect(screen.queryByTestId('access-review-change-due')).toBeNull();
        r1.unmount();

        const r2 = renderPage({ status: 'CLOSED', evidenceFileRecordId: 'file_1' }, { canManage: true });
        expect(screen.queryByTestId('access-review-change-reviewer')).toBeNull();
        r2.unmount();

        renderPage({ scope: 'AGENT', decisions: [] }, { canManage: true });
        expect(screen.queryByTestId('access-review-change-reviewer')).toBeNull();
        expect(screen.queryByTestId('access-review-change-due')).toBeNull();
    });
});

describe('a closed member campaign whose evidence PDF failed', () => {
    const closedNoPdf = { status: 'CLOSED', closedAt: new Date('2026-10-20').toISOString(), evidenceFileRecordId: null };

    it('says so, and an Owner/Admin can produce it again', async () => {
        renderPage(closedNoPdf, { canRegenerateEvidence: true });
        expect(screen.getByTestId('access-review-evidence-missing')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('access-review-regenerate-evidence'));
        await waitFor(() => expect(writes('POST')).toHaveLength(1));
        expect(writes('POST')[0][0]).toBe('/api/t/acme/access-reviews/rev_1/evidence/regenerate');
    });

    it('a reader is told an Owner or Admin can produce it, and is offered no button', () => {
        renderPage(closedNoPdf, { isAdmin: false, canRegenerateEvidence: false, currentUserId: 'usr_reviewer' });
        expect(screen.getByTestId('access-review-evidence-missing').textContent).toMatch(/An Owner or Admin can produce it/);
        expect(screen.queryByTestId('access-review-regenerate-evidence')).toBeNull();
    });

    it('a campaign that has its PDF offers the download, not the regeneration', () => {
        renderPage({ ...closedNoPdf, evidenceFileRecordId: 'file_1' }, { canRegenerateEvidence: true });
        expect(screen.getByTestId('access-review-download-evidence')).toBeInTheDocument();
        expect(screen.queryByTestId('access-review-regenerate-evidence')).toBeNull();
        expect(screen.queryByTestId('access-review-evidence-missing')).toBeNull();
    });
});
