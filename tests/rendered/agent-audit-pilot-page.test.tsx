/**
 * THE AUDIT PILOT SET-UP PAGE, rendered (#3807, the page for step 3c's set-up,
 * which was a script the production image could not run).
 *
 *   1. IT OPENS ON A DRY RUN: the first request is `{ apply: false }`, and the
 *      steps it reports are shown as what WOULD happen.
 *   2. ONLY "SET UP" WRITES, through a confirmation, sending `{ apply: true }`
 *      with the same inputs the dry run was checked with.
 *   3. A REFUSAL IS THE ANSWER, not an error: its name and sentence are shown,
 *      and Set up stays off. A control refusal points at the control picker.
 *   4. Nothing to change offers nothing to apply.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/agents/audit-pilot',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values ? v.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m)) : v;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { AuditPilotClient } from '@/app/t/[tenantSlug]/(app)/agents/audit-pilot/AuditPilotClient';

const PROCEDURES = [
    { id: 'iam.leaver_timeliness', title: 'Leaver timeliness' },
    { id: 'agent.authority_conformance', title: 'Agent authority conformance' },
];

const DRY_RUN = {
    ok: true,
    applied: false,
    agentId: null,
    steps: [
        { step: 'register auditor', outcome: 'WOULD_CHANGE', detail: 'would register "Pilot auditor (library v1)" as an auditor' },
        { step: 'activate', outcome: 'PENDING', detail: "UNSCORED: complete the agent's risk assessment in the product" },
    ],
};

type Call = { url: string; method?: string; body: unknown };

function mockFetch(answers: unknown[]) {
    const calls: Call[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        // The two control pickers search `/controls` once on mount, after a
        // 250 ms debounce. Answered from the queue, those reads took the
        // set-up's answers whenever the page took longer than that to render,
        // which a loaded CI runner does: the second dry run then received the
        // APPLIED answer and Set up stayed disabled. Only the set-up POSTs read
        // the queue.
        if (init?.method !== 'POST') return { ok: true, json: async () => ({ items: [] }) } as Response;
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        return { ok: true, json: async () => answer } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

const renderPage = () =>
    render(<AuditPilotClient defaultAgentName="Pilot auditor (library v1)" procedures={PROCEDURES} />);

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

beforeEach(() => jest.clearAllMocks());

it('opens on a dry run and shows what would happen', async () => {
    const calls = mockFetch([DRY_RUN]);
    renderPage();
    const steps = await screen.findByTestId('audit-pilot-steps');
    expect(posts(calls)[0]).toEqual({ url: '/api/t/acme/admin/agents/audit-pilot', method: 'POST', body: { apply: false } });
    expect(screen.getByTestId('audit-pilot-result')).toHaveTextContent('What the set-up would do');
    expect(steps).toHaveTextContent('Would change');
    expect(steps).toHaveTextContent('UNSCORED');
});

it('writes only through the confirmation, with the inputs it was checked with', async () => {
    const applied = { ...DRY_RUN, applied: true, steps: [{ step: 'register auditor', outcome: 'CHANGED', detail: 'registered' }] };
    const calls = mockFetch([DRY_RUN, DRY_RUN, applied]);
    renderPage();
    await screen.findByTestId('audit-pilot-steps');

    fireEvent.change(screen.getByLabelText('Auditor name'), { target: { value: 'Second-line auditor' } });
    fireEvent.click(screen.getByTestId('audit-pilot-check'));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1].body).toEqual({ apply: false, agentName: 'Second-line auditor' });

    await waitFor(() => expect(screen.getByTestId('audit-pilot-apply')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('audit-pilot-apply'));
    expect(posts(calls)).toHaveLength(2);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up the pilot' }));

    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(posts(calls)[2].body).toEqual({ apply: true, agentName: 'Second-line auditor' });
    expect(await screen.findByText('What the set-up did')).toBeInTheDocument();
});

it('shows a refusal by name and sentence, offers nothing to apply, and points a control refusal at the picker', async () => {
    mockFetch([
        {
            ok: false,
            refusal: 'CONTROL_AMBIGUOUS',
            detail: 'iam.leaver_timeliness maps by A.5.18 to 2 controls (c1, c2); name the control it should run on.',
        },
    ]);
    renderPage();
    const refusal = await screen.findByTestId('audit-pilot-refusal');
    expect(refusal).toHaveTextContent('CONTROL_AMBIGUOUS');
    expect(refusal).toHaveTextContent('maps by A.5.18 to 2 controls');
    expect(refusal).toHaveTextContent('Name the control for that procedure above');
    expect(screen.getByTestId('audit-pilot-apply')).toBeDisabled();
    expect(screen.getByTestId('audit-pilot-procedure-iam.leaver_timeliness')).toBeInTheDocument();
});

it('offers nothing to apply when every step is already in place', async () => {
    mockFetch([{ ok: true, applied: false, agentId: 'agt_1', steps: [{ step: 'activate', outcome: 'UNCHANGED', detail: 'ACTIVE' }] }]);
    renderPage();
    expect(await screen.findByTestId('audit-pilot-steps')).toHaveTextContent('In place');
    expect(screen.getByTestId('audit-pilot-apply')).toBeDisabled();
});
