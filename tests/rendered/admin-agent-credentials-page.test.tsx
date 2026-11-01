/**
 * #4879 — the Agent credentials page says whether each key can act right now.
 *
 * A key bound to a suspended or killed agent used to read "Live"; the autonomy
 * ceiling was a bare number; nothing linked to the API keys page, where a key
 * is revoked; and a list cut at 200 passed for the whole population.
 */
import * as React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown> & {
    admin: { mcp: Record<string, string> & { stoppedReason: Record<string, string>; ungovernedReason: Record<string, string> } };
};
const mcp = EN.admin.mcp;

jest.mock('next-intl/server', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const lookup = (o: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const bag = lookup(en, ns);
            const t = (key: string, values?: Record<string, unknown>) => {
                const v = lookup(bag, key);
                if (typeof v !== 'string') return key;
                return v.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? ''));
            };
            t.rich = (key: string) => t(key);
            return t;
        },
    };
});

const gate = { allowed: true, ctx: { tenantId: 't1' }, tenantSlug: 'acme' };
jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    gateAdminPage: async () => gate,
}));

type Row = Record<string, unknown>;
const listed: { credentials: Row[]; truncated: boolean } = { credentials: [], truncated: false };
jest.mock('@/app-layer/usecases/api-keys', () => ({
    __esModule: true,
    listAgentCredentials: async () => listed,
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import McpPage from '@/app/t/[tenantSlug]/(app)/admin/mcp/page';

function credential(over: Row): Row {
    return {
        id: 'k1',
        name: 'Deploy bot key',
        keyPrefix: 'iflk_ab12',
        scopes: ['mcp:read'],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        state: 'live',
        agent: { id: 'a1', name: 'Deploy bot', status: 'ACTIVE', autonomyLevel: 3, riskTier: 'LOW' },
        keyMaxAutonomy: null,
        standing: { kind: 'governed' },
        effectiveAutonomy: 2,
        unscored: false,
        ...over,
    };
}

afterEach(() => {
    cleanup();
    listed.credentials = [];
    listed.truncated = false;
});

async function renderPage() {
    const el = await McpPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(
        <NextIntlClientProvider locale="en" messages={EN}>
            {el}
        </NextIntlClientProvider>,
    );
}

function entry(id: string): HTMLElement {
    const el = document.getElementById(`mcp-agent-credential-${id}`);
    if (!el) throw new Error(`no entry ${id}`);
    return el;
}

describe('whether a key can act', () => {
    it('a governed key reads Live with its ceiling in words, and links its agent', async () => {
        listed.credentials = [credential({})];
        await renderPage();
        const row = entry('k1');
        expect(row.querySelector('[data-standing]')).toHaveTextContent(mcp.credentialLive);
        expect(row).toHaveTextContent('Autonomy ceiling L2 · proposes');
        expect(within(row).getByRole('link', { name: 'Deploy bot' })).toHaveAttribute('href', '/t/acme/agents/a1');
    });

    it('a key bound to a suspended agent reads Stopped, with the reason, and no ceiling', async () => {
        listed.credentials = [credential({ standing: { kind: 'stopped', reason: 'AGENT_SUSPENDED' } })];
        await renderPage();
        const row = entry('k1');
        expect(row.querySelector('[data-standing]')).toHaveTextContent(mcp.credentialStopped);
        expect(row).toHaveTextContent(mcp.stoppedReason.AGENT_SUSPENDED);
        expect(row).not.toHaveTextContent(mcp.credentialLive);
        expect(row.querySelector('[data-autonomy]')).toBeNull();
    });

    it('a killed agent and an unassessed agent are stops too', async () => {
        listed.credentials = [
            credential({ id: 'k1', standing: { kind: 'stopped', reason: 'KILL_AGENT' } }),
            credential({ id: 'k2', standing: { kind: 'stopped', reason: 'UNASSESSED' }, effectiveAutonomy: -1 }),
        ];
        await renderPage();
        expect(entry('k1')).toHaveTextContent(mcp.stoppedReason.KILL_AGENT);
        expect(entry('k2')).toHaveTextContent(mcp.stoppedReason.UNASSESSED);
        expect(document.body.textContent).not.toContain('-1');
    });

    it('an unbound key that reaches the agent tools says no agent controls apply', async () => {
        listed.credentials = [
            credential({ agent: null, standing: { kind: 'ungoverned', reason: 'NO_AGENT' }, effectiveAutonomy: 6 }),
        ];
        await renderPage();
        const row = entry('k1');
        expect(row.querySelector('[data-standing]')).toHaveTextContent(mcp.credentialUngoverned);
        expect(row).toHaveTextContent(mcp.ungovernedReason.NO_AGENT);
        expect(row).toHaveTextContent(mcp.credentialNoAgent);
        expect(row).toHaveTextContent('Autonomy ceiling L6 · orchestrates');
    });

    it('a revoked key says when, and an unused key says so', async () => {
        listed.credentials = [
            credential({
                state: 'revoked',
                revokedAt: new Date('2026-10-30T09:15:00Z'),
                standing: { kind: 'inactive' },
            }),
        ];
        await renderPage();
        const row = entry('k1');
        expect(row.querySelector('[data-standing]')).toHaveTextContent(mcp.credentialRevoked);
        expect(row).toHaveTextContent('Revoked 30 Oct 2026, 09:15');
        expect(row).toHaveTextContent(mcp.neverUsed);
    });
});

describe('the way to act, and the whole population', () => {
    it('links to API keys from the description and from the empty state', async () => {
        await renderPage();
        const links = screen.getAllByRole('link', { name: mcp.manageKeys });
        expect(links.length).toBe(2);
        for (const link of links) expect(link).toHaveAttribute('href', '/t/acme/admin/api-keys');
    });

    it('says when the list is cut short', async () => {
        listed.credentials = [credential({})];
        listed.truncated = true;
        await renderPage();
        expect(document.getElementById('mcp-agent-credentials-truncated')).toHaveTextContent(
            'Showing the 1 newest credentials.',
        );
    });

    it('a complete list carries no truncation notice', async () => {
        listed.credentials = [credential({})];
        await renderPage();
        expect(document.getElementById('mcp-agent-credentials-truncated')).toBeNull();
    });
});
