/**
 * THE COMPOSE PAGE, rendered (#4895), against the real `messages/en.json`.
 *
 *   1. ONLY COMPOSABLE TEMPLATES ARE OFFERED, and the ones left out are
 *      counted, so a missing template is explained rather than absent.
 *   2. THE TOOL IS NAMED in words with its connection, never by its key.
 *   3. FIELDS ARE LABELLED in words, hinted by their bound, an enum offered as
 *      a choice, and two open subjects told apart.
 *   4. OUTCOMES POINT WHERE THE REQUEST WAITS, without a proposal id or a
 *      guard verdict code; a failure is a sentence, never a bare status.
 *   5. THE INTRO PROMISES A SECOND APPROVER only while the Owner's switch says so.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/agents/compose',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    /** `{count, plural, one {…} other {…}}` with `#`, which IntlMessageFormat (ESM) would do. */
    const plural = (s: string, values: Record<string, string | number>) =>
        s.replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_m, name, one, other) => {
            const n = Number(values[name]);
            return (n === 1 ? one : other).replace(/#/g, String(n));
        });
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            if (!values) return v;
            return plural(v, values).replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m));
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

import { ComposeClient, fieldNameInWords } from '@/app/t/[tenantSlug]/(app)/agents/compose/ComposeClient';

const en = require('../../messages/en.json');
const C = en.agents.compose;

const TEMPLATES = [{ id: 'set-1', label: 'Grant a role', toolName: 'grant_role', connectionName: 'Entra (production)' }];

type Answer = { ok: boolean; status?: number; body: unknown };

function mockFetch(answers: { get?: Answer; post?: Answer }) {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const a = init?.method === 'POST' ? answers.post : answers.get;
        if (!a) throw new Error('network');
        return { ok: a.ok, status: a.status ?? (a.ok ? 200 : 500), json: async () => a.body } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

async function choose(placeholder: string, option: string) {
    fireEvent.click(screen.getByText(placeholder));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: option }));
}

const FIELDS = {
    fields: [
        { name: 'targetUserId', kind: 'target', candidates: [{ value: 'u1', label: 'Ada Lovelace' }] },
        { name: 'role_name', kind: 'enum', allowed: ['reader', 'editor'] },
        { name: 'days', kind: 'integer', min: 1, max: 30 },
    ],
};

beforeEach(() => jest.clearAllMocks());

it('names a field in words', () => {
    expect(fieldNameInWords('targetUserId')).toBe('Target user id');
    expect(fieldNameInWords('role_name')).toBe('Role name');
    expect(fieldNameInWords('days')).toBe('Days');
});

it('names the tool with its connection, and labels each field by its bound', async () => {
    mockFetch({ get: { ok: true, body: FIELDS } });
    render(<ComposeClient templates={TEMPLATES} canWrite />);
    await choose(C.templatePlaceholder, 'Grant a role');
    expect(screen.getByTestId('compose-tool-line')).toHaveTextContent('Uses the grant_role tool on Entra (production).');
    expect(await screen.findByText('Role name')).toBeInTheDocument();
    expect(screen.getByText('Choose one of the values the approved template allows.')).toBeInTheDocument();
    expect(screen.getByText('A whole number from 1 to 30.')).toBeInTheDocument();
    // One open subject reads "Subject"; nothing reads as a key or a kind.
    expect(screen.getByText(C.subjectLabel)).toBeInTheDocument();
    expect(screen.queryByText(/\(integer\)|\(enum\)|mcp__/)).toBeNull();
});

it('tells two open subjects apart', async () => {
    mockFetch({
        get: {
            ok: true,
            body: {
                fields: [
                    { name: 'grantee', kind: 'target', candidates: [{ value: 'u1', label: 'Ada' }] },
                    { name: 'approver', kind: 'target', candidates: [{ value: 'u2', label: 'Bo' }] },
                ],
            },
        },
    });
    render(<ComposeClient templates={TEMPLATES} canWrite />);
    await choose(C.templatePlaceholder, 'Grant a role');
    expect(await screen.findByText('Subject: Grantee')).toBeInTheDocument();
    expect(screen.getByText('Subject: Approver')).toBeInTheDocument();
});

it('a queued request points at the proposal queue and quotes no id', async () => {
    const calls = mockFetch({
        get: { ok: true, body: { fields: [{ name: 'ticket', kind: 'regex' }] } },
        post: { ok: true, body: { proposalId: 'cm_abc123', status: 'PENDING', guardVerdict: null } },
    });
    render(<ComposeClient templates={TEMPLATES} canWrite />);
    await choose(C.templatePlaceholder, 'Grant a role');
    fireEvent.change(await screen.findByLabelText('Ticket'), { target: { value: 'INC-1' } });
    fireEvent.click(screen.getByRole('button', { name: C.submit }));
    const notice = await screen.findByTestId('compose-notice');
    expect(notice).toHaveTextContent(C.queued);
    expect(notice).not.toHaveTextContent('cm_abc123');
    expect(screen.getByTestId('compose-open-proposals')).toHaveAttribute('href', '/t/acme/agents/proposals');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        parameterSetId: 'set-1',
        openFieldValues: { ticket: 'INC-1' },
    });
});

it('a quarantined request names no verdict code, and links quarantine only for a viewer it admits', async () => {
    mockFetch({
        get: { ok: true, body: { fields: [{ name: 'ticket', kind: 'regex' }] } },
        post: { ok: true, body: { proposalId: 'cm_abc123', status: 'QUARANTINED', guardVerdict: 'QUARANTINED' } },
    });
    const { unmount } = render(
        <ComposeClient
            templates={TEMPLATES}
            canWrite
            menu={{ tenantSlug: 'acme', canReviewProposals: true, canInvestigate: false }}
        />,
    );
    await choose(C.templatePlaceholder, 'Grant a role');
    fireEvent.change(await screen.findByLabelText('Ticket'), { target: { value: 'INC-1' } });
    fireEvent.click(screen.getByRole('button', { name: C.submit }));
    const notice = await screen.findByTestId('compose-notice');
    expect(notice).toHaveTextContent(C.quarantined);
    expect(notice).not.toHaveTextContent('(QUARANTINED)');
    expect(screen.queryByTestId('compose-open-quarantine')).toBeNull();
    unmount();
});

it('a failure without a sentence is never a bare status', async () => {
    mockFetch({ get: { ok: false, status: 500, body: null } });
    render(<ComposeClient templates={TEMPLATES} canWrite />);
    await choose(C.templatePlaceholder, 'Grant a role');
    const notice = await screen.findByTestId('compose-notice');
    expect(notice).toHaveTextContent(C.tryAgain);
    expect(notice).not.toHaveTextContent('500');
});

it('a network failure says so', async () => {
    mockFetch({});
    render(<ComposeClient templates={TEMPLATES} canWrite />);
    await choose(C.templatePlaceholder, 'Grant a role');
    await waitFor(() => expect(screen.getByTestId('compose-notice')).toHaveTextContent(C.networkFailed));
});

it('says how many templates were left out, and why', () => {
    render(<ComposeClient templates={TEMPLATES} notComposable={2} canWrite />);
    expect(screen.getByTestId('compose-not-composable')).toHaveTextContent(
        '2 saved parameter sets are not offered here, because they leave no fields to fill in.',
    );
});

it('with nothing to compose, a manager is sent to Saved parameters', () => {
    render(<ComposeClient templates={[]} canWrite canManageTemplates />);
    expect(screen.getByText(C.noTemplatesManagerDesc)).toBeInTheDocument();
    expect(screen.getByTestId('compose-open-parameter-sets')).toHaveAttribute('href', '/t/acme/agents/parameter-sets');
});

it('with nothing to compose, a viewer who cannot open Saved parameters gets no link', () => {
    render(<ComposeClient templates={[]} canWrite />);
    expect(screen.getByText(C.noTemplatesDesc)).toBeInTheDocument();
    expect(screen.queryByTestId('compose-open-parameter-sets')).toBeNull();
});

it('promises a second approver only while the Owner requires one', () => {
    const { unmount } = render(<ComposeClient templates={TEMPLATES} canWrite needsSecondApprover />);
    expect(screen.getByText(C.intro)).toBeInTheDocument();
    unmount();
    render(<ComposeClient templates={TEMPLATES} canWrite needsSecondApprover={false} />);
    expect(screen.getByText(C.introSelfApproval)).toBeInTheDocument();
    expect(screen.queryByText(C.intro)).toBeNull();
});
