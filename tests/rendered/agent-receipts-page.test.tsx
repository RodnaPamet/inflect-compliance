/**
 * THE AGENT RECEIPTS PAGE, rendered (#4897), against the real `messages/en.json`.
 *
 *   1. A ROW SPEAKS IN WORDS: the tool in words (and its connection), the
 *      mediator's verdict worded when known and quoted as its word when not.
 *   2. THE AGENT IS OUR BINDING, linked; the receipt's own claim appears only
 *      where the read carried it (verified receipts), labelled as its claim.
 *   3. EXPORT DOWNLOADS A FILE; the evidence (audit entry, tool description)
 *      is on the row.
 *   4. THE LIST NARROWS and says when it is cut; empty is an EmptyState.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
function translator(ns: string) {
    return (key: string, values?: Record<string, string | number>) => {
        const v = key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
        if (typeof v !== 'string') return `${ns}.${key}`;
        if (!values) return v;
        return v
            .replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_m, name, one, other) =>
                (Number(values[name]) === 1 ? one : other).replace(/#/g, String(values[name])),
            )
            .replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m));
    };
}
jest.mock('next-intl/server', () => ({ getTranslations: async (ns: string) => translator(ns) }));
jest.mock('next-intl', () => ({ useTranslations: (ns: string) => translator(ns), useLocale: () => 'en' }));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/receipts',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

const ctx = {
    tenantId: 't1',
    appPermissions: { admin: { view: true, agent_registry: true, tenant_lifecycle: false } },
};
jest.mock('@/app-layer/context', () => ({ getTenantCtx: jest.fn(async () => ctx) }));
jest.mock('@/app-layer/usecases/agent-oversight-settings', () => ({
    oversightReadsFor: jest.fn(async () => ({ decisions: true, receipts: true, quarantine: true })),
}));
const mockRead = jest.fn();
jest.mock('@/app-layer/usecases/agent-action-receipt', () => ({ readReceiptPage: (...a: unknown[]) => mockRead(...a) }));

import AgentReceiptsPage from '@/app/t/[tenantSlug]/(app)/agents/receipts/page';

interface ReceiptMessages {
    receiptVerdict: Record<string, string>;
    receiptProvenanceValue: Record<string, string>;
    receiptNoAgent: string;
    receiptsEmptyNarrowedTitle: string;
    receiptsFilterVerified: string;
    receiptsEmptyTitle: string;
    receiptsEmpty: string;
    receiptsCapped: string;
}
const M = (en.admin as unknown as { mcp: ReceiptMessages }).mcp;

const row = (over: Record<string, unknown>) => ({
    id: 'r1',
    toolName: 'list_risks',
    connectionName: null,
    decisionVerdict: 'allow',
    activePolicy: null,
    verified: true,
    occurredAt: '2026-11-01T10:00:00.000Z',
    agent: null,
    claimedAgentId: null,
    auditLogId: 'audit_1',
    toolProvenance: 'inflect:builtin',
    toolManifestRevision: null,
    ...over,
});

async function renderPage(query: Record<string, string> = {}) {
    const el = await AgentReceiptsPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
        searchParams: Promise.resolve(query),
    });
    return render(el);
}

beforeEach(() => mockRead.mockReset());

it('words the tool and the verdict, and quotes a verdict it does not know', async () => {
    mockRead.mockResolvedValueOnce({
        rows: [
            row({ id: 'a', toolName: 'grant_role', connectionName: 'Entra (production)', decisionVerdict: 'deny' }),
            row({ id: 'b', decisionVerdict: 'escalate-to-human' }),
        ],
        capped: null,
    });
    await renderPage();
    const a = screen.getByTestId('receipt-a');
    expect(a).toHaveTextContent('Grant role on Entra (production)');
    expect(a).toHaveTextContent(M.receiptVerdict.BLOCKED);
    expect(a).not.toHaveTextContent('grant_role');
    expect(screen.getByTestId('receipt-b')).toHaveTextContent('Mediator: escalate-to-human');
});

it('names the bound agent with a link, and the receipt’s claim only where it was carried', async () => {
    mockRead.mockResolvedValueOnce({
        rows: [
            row({ id: 'v', agent: { id: 'agt_1', name: 'Posture reviewer' }, claimedAgentId: 'pipelock-run-42' }),
            row({ id: 'u', verified: false, agent: null, claimedAgentId: null }),
        ],
        capped: null,
    });
    await renderPage();
    expect(screen.getByTestId('receipt-agent-v')).toHaveAttribute('href', '/t/acme/agents/agt_1');
    expect(screen.getByTestId('receipt-claim-v')).toHaveTextContent('The receipt names agent pipelock-run-42');
    expect(screen.queryByTestId('receipt-claim-u')).toBeNull();
    expect(screen.getByTestId('receipt-u')).toHaveTextContent(M.receiptNoAgent);
});

it('exports as a download, and shows the evidence on the row', async () => {
    mockRead.mockResolvedValueOnce({ rows: [row({ id: 'r1' })], capped: null });
    await renderPage();
    const exp = screen.getByTestId('receipt-export-r1');
    expect(exp).toHaveAttribute('href', '/api/t/acme/agent-receipts/r1/export');
    expect(exp).toHaveAttribute('download', 'agent-receipt-r1.json');
    const evidence = screen.getByTestId('receipt-evidence-r1');
    expect(evidence).toHaveTextContent('audit_1');
    expect(evidence).toHaveTextContent(M.receiptProvenanceValue.BUILTIN);
});

it('narrows to unverified receipts, says so, and offers the way back', async () => {
    mockRead.mockResolvedValueOnce({ rows: [], capped: null });
    await renderPage({ verified: 'no' });
    expect(mockRead).toHaveBeenCalledWith(ctx, { verified: false, toolName: undefined });
    expect(screen.getByText(M.receiptsEmptyNarrowedTitle)).toBeInTheDocument();
    expect(screen.getByTestId('receipts-show-all')).toHaveAttribute('href', '/t/acme/agents/receipts');
    const filters = screen.getByTestId('receipts-filters');
    expect(within(filters).getByRole('link', { name: M.receiptsFilterVerified }).getAttribute('href')).toBe(
        '/t/acme/agents/receipts?verified=yes',
    );
});

it('an empty log is an empty state that says how receipts arrive', async () => {
    mockRead.mockResolvedValueOnce({ rows: [], capped: null });
    await renderPage();
    expect(screen.getByText(M.receiptsEmptyTitle)).toBeInTheDocument();
    expect(screen.getByText(M.receiptsEmpty)).toBeInTheDocument();
    expect(screen.queryByTestId('receipts-show-all')).toBeNull();
});

it('says when the list is cut, and how many it shows', async () => {
    mockRead.mockResolvedValueOnce({ rows: [row({ id: 'r1' })], capped: 100 });
    await renderPage();
    expect(screen.getByTestId('receipts-capped')).toHaveTextContent(M.receiptsCapped.replace('{count}', '100'));
    expect(screen.getByTestId('receipts-count')).toHaveTextContent('The newest 1 receipts');
});
