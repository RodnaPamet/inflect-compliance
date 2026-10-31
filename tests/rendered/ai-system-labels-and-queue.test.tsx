/** @jest-environment jsdom */

/**
 * #4638 — the AI-system register and detail page read in words, and a queued
 * conformity draft links only to a page its author can open.
 *
 * The register and the detail page printed the stored tier (`HIGH`,
 * `UNCLASSIFIED`) in every badge, in the header line and in the classify
 * toast, though the filter already labelled it. The register's role column and
 * the three conformity buttons were hard-coded English. And generating a draft
 * needs only write access, so an Editor could queue one and was then linked to
 * the agent proposals queue, which refuses them.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// Resolves real en.json values and `{name}` placeholders; memoised per
// namespace so `useMemo([tx])` downstream does not loop.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const ReactActual = jest.requireActual('react');
    // Flat `plural` blocks (`=N` / `one` / `other`), as the catalogue writes them.
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            if (typeof val !== 'string') return key;
            const has = (name: string) => !!params && Object.prototype.hasOwnProperty.call(params, name);
            return val
                .replace(PLURAL, (block: string, name: string, options: string) => {
                    if (!has(name)) return block;
                    const n = Number(params![name]);
                    const forms = new Map<string, string>();
                    for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                    const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                    return body === undefined ? block : body.split('#').join(String(n));
                })
                .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(name) ? String(params![name]) : m));
        };
        // `.rich` renders `<tag>…</tag>` through the matching function, so a
        // link inside a sentence is a real link.
        const rich = (key: string, params?: Record<string, unknown>) => {
            const str = t(key, params);
            const out: unknown[] = [];
            const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
            let last = 0;
            let m: RegExpExecArray | null;
            let i = 0;
            while ((m = re.exec(str))) {
                if (m.index > last) out.push(str.slice(last, m.index));
                const fn = params?.[m[1]] as ((c: unknown) => unknown) | undefined;
                out.push(fn ? ReactActual.cloneElement(fn(m[2]), { key: i++ }) : m[2]);
                last = re.lastIndex;
            }
            if (last < str.length) out.push(str.slice(last));
            return out;
        };
        t.rich = rich; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => typeof lookup(ns, k) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', systemId: 'sys-1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/ai-systems',
    useSearchParams: () => new URLSearchParams(),
}));

import { SWRConfig } from 'swr';
import { AiSystemsClient, type AiSystemRow } from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient';
import {
    AiSystemDetailClient,
    type AiSystemDetail,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';

const AI = (
    jest.requireActual('../../messages/en.json') as {
        risks: {
            aiSystems: {
                provider: string;
                deployer: string;
                filterEnums: { riskTier: Record<string, string> };
                detail: Record<string, string> & { docTypes: Record<string, string> };
            };
        };
    }
).risks.aiSystems;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'EDITOR' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: getPermissionsForRole('EDITOR'),
    modules: { processCanvas: false },
};

function Wrapper({ children }: { children: React.ReactNode }) {
    return (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>{children}</TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>
    );
}

function row(id: string, riskTier: string, deploymentRole: string): AiSystemRow {
    return {
        id, name: `System ${id}`, provider: null, deploymentRole, riskTier,
        classificationClauseId: riskTier === 'UNCLASSIFIED' ? null : 'Annex III(4)',
        status: 'ACTIVE', ownerUserId: null, createdAt: '2026-01-01T00:00:00.000Z',
        _count: { requirementLinks: 0 },
    };
}

const HIGH_SYSTEM: AiSystemDetail = {
    id: 'sys-1', name: 'Credit scorer', provider: 'Acme Labs', deploymentRole: 'DEPLOYER', riskTier: 'HIGH',
    status: 'ACTIVE', purpose: null, useContext: null,
    classificationClauseId: 'Annex III(5)', classificationRationale: 'Creditworthiness of natural persons.',
    requirementLinks: [],
};

function rowOf(id: string): HTMLElement {
    const tr = screen.getByTestId(`ai-system-row-${id}`).closest('tr');
    if (!tr) throw new Error(`no row for ${id}`);
    return tr as HTMLElement;
}

describe('the register reads in words (#4638)', () => {
    it('labels each tier and role, and prints no stored code', async () => {
        render(
            <Wrapper>
                <AiSystemsClient
                    initialRows={[row('a', 'HIGH', 'PROVIDER'), row('b', 'UNCLASSIFIED', 'DEPLOYER')]}
                    tenantSlug="acme"
                    canWrite
                />
            </Wrapper>,
        );
        await waitFor(() => expect(screen.getByTestId('ai-system-row-a')).toBeTruthy());

        const high = rowOf('a').textContent ?? '';
        expect(high).toContain(AI.filterEnums.riskTier.HIGH);
        expect(high).toContain(AI.provider);
        expect(high).not.toContain('HIGH');
        expect(high).not.toContain('PROVIDER');

        const provisional = rowOf('b').textContent ?? '';
        expect(provisional).toContain(AI.filterEnums.riskTier.UNCLASSIFIED);
        expect(provisional).toContain(AI.deployer);
        expect(provisional).not.toContain('UNCLASSIFIED');
        expect(provisional).not.toContain('DEPLOYER');
    });
});

function renderDetail(canOpenApprovalQueue: boolean) {
    return render(
        <Wrapper>
            <AiSystemDetailClient system={HIGH_SYSTEM} tenantSlug="acme" canWrite canOpenApprovalQueue={canOpenApprovalQueue} />
        </Wrapper>,
    );
}

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ proposalId: 'p-1' }) });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('the detail page reads in words (#4638)', () => {
    it('labels the tier in the header line and both badges', async () => {
        const { container } = renderDetail(true);
        await waitFor(() => expect(screen.getByTestId('page-header-title').textContent).toBe('Credit scorer'));
        expect(screen.getByTestId('page-header-description').textContent).toBe(
            AI.detail.metaLine
                .replace('{tier}', AI.filterEnums.riskTier.HIGH)
                .replace('{clause}', 'Annex III(5)')
                .replace('{role}', AI.deployer),
        );
        // The header badge and the classification row's badge.
        expect(screen.getAllByText(AI.filterEnums.riskTier.HIGH)).toHaveLength(2);
        expect(container.textContent).not.toContain('HIGH');
    });

    it('labels the three conformity buttons from the catalogue', async () => {
        renderDetail(true);
        for (const label of Object.values(AI.detail.docTypes)) {
            expect(await screen.findByRole('button', { name: label })).toBeEnabled();
        }
    });
});

describe('a queued draft links only to a page its author can open (#4638)', () => {
    async function queueOne(canOpenApprovalQueue: boolean) {
        renderDetail(canOpenApprovalQueue);
        const button = await screen.findByRole('button', { name: AI.detail.docTypes.ART_9_RISK_MANAGEMENT });
        await act(async () => { fireEvent.click(button); });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            '/api/t/acme/ai-systems/sys-1/conformity',
            expect.objectContaining({ method: 'POST', body: JSON.stringify({ docType: 'ART_9_RISK_MANAGEMENT' }) }),
        ));
        return screen.findByText((_, el) => el?.id === 'ai-system-drafts-queued');
    }

    it('links a reviewer of agent proposals to the approval queue', async () => {
        const note = await queueOne(true);
        const link = within(note).getByRole('link', { name: AI.detail.approvalQueue });
        expect(link.getAttribute('href')).toBe('/t/acme/agent-proposals');
    });

    it('tells anyone else where an approved draft lands, and links there instead', async () => {
        const note = await queueOne(false);
        expect(note.textContent).toContain(AI.detail.draftsQueuedNoQueueSingular);
        expect(within(note).queryByRole('link', { name: AI.detail.approvalQueue })).toBeNull();
        const link = within(note).getByRole('link', { name: AI.detail.openPolicies });
        expect(link.getAttribute('href')).toBe('/t/acme/policies');
        expect(document.querySelector('a[href="/t/acme/agent-proposals"]')).toBeNull();
    });
});

describe('the detail page remembers its drafts and names its obligations (#4777)', () => {
    it('lists the drafts already queued and keeps their button off', async () => {
        render(
            <Wrapper>
                <AiSystemDetailClient
                    system={HIGH_SYSTEM}
                    drafts={[{ proposalId: 'p-0', docType: 'ART_9_RISK_MANAGEMENT', status: 'PENDING', createdAt: '2026-10-01T00:00:00.000Z' }]}
                    tenantSlug="acme"
                    canWrite
                    canOpenApprovalQueue
                />
            </Wrapper>,
        );
        expect(await screen.findByTestId('ai-system-draft-ART_9_RISK_MANAGEMENT')).toHaveTextContent(AI.detail.draftStatus_PENDING);
        const buttons = screen.getAllByRole('button', { name: AI.detail.queued });
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toBeDisabled();
        expect(screen.getByRole('button', { name: AI.detail.docTypes.ANNEX_IV_TECHNICAL_DOCUMENTATION })).toBeEnabled();
    });

    it('shows the status and names each obligation by its framework, with a link', async () => {
        render(
            <Wrapper>
                <AiSystemDetailClient
                    system={{
                        ...HIGH_SYSTEM,
                        requirementLinks: [{ id: 'l1', requirement: { id: 'r1', code: 'Art.9', title: 'Risk management system', framework: { key: 'EU-AI-ACT', name: 'EU AI Act' } } }],
                    }}
                    tenantSlug="acme"
                    canWrite
                    canOpenApprovalQueue
                />
            </Wrapper>,
        );
        expect(await screen.findByTestId('ai-system-status')).toHaveTextContent(AI.detail.status_ACTIVE);
        const row = screen.getByTestId('ai-system-obligation-l1');
        expect(row).toHaveTextContent('EU AI Act Art.9');
        expect(row).not.toHaveTextContent('EU-AI-ACT');
        expect(screen.getByRole('link', { name: 'Risk management system' })).toHaveAttribute('href', '/t/acme/frameworks/EU-AI-ACT');
    });
});
