/**
 * The integration passport card (#3672) — what an OWNER reads about one
 * external agent connection.
 *
 * Four claims, each about what reaches a person's eyes, which is why they are
 * rendered rather than asserted on the usecase:
 *
 *   • the passport's fields render from the server's answer, tool names shown
 *     without the connection prefix the rows are stored under;
 *   • a connection with no accountable owner SAYS so — a quiet card would read
 *     as "somebody answers for this", which is the opposite of the truth, and
 *     the owner who left is told apart from the owner never named;
 *   • a pinned tool that declares a write and has no prior-state pairing is
 *     marked, because dispatch refuses a write to it and nothing else on the
 *     page would say why;
 *   • a 404 or a 403 renders NOTHING. The connection page is shared by every
 *     provider and only `mcp-server` connections have a passport, so on any
 *     other connection the card must be absent rather than an error.
 *
 * next-intl is mocked to resolve REAL `messages/en.json` values, so a key
 * missing from the catalogue renders as its own dotted path and fails the text
 * assertions instead of passing them. `t` is memoised per namespace: a fresh
 * identity each render would invalidate the card's `useMemo([t])` columns and
 * loop.
 */
import * as React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const at = (path: string, from: unknown): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            from,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    return {
        useTranslations: (ns: string) => {
            const hit = cache.get(ns);
            if (hit) return hit;
            const t = (key: string, params?: Record<string, unknown>) => {
                let v = at(key, at(ns, en));
                if (typeof v !== 'string') return `${ns}.${key}`;
                for (const [p, val] of Object.entries(params ?? {})) {
                    v = (v as string).split(`{${p}}`).join(String(val));
                }
                return v as string;
            };
            cache.set(ns, t);
            return t;
        },
        useLocale: () => 'en',
    };
});

// STABLE identities, as the real hooks' `useCallback` gives: a fresh function
// per render would re-run the card's fetch effect on every render.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import { IntegrationPassportCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationPassportCard';
import type { IntegrationPassportView } from '@/app-layer/usecases/integration-passport';

const C = 'conn_1';
const q = (tool: string) => `mcp__${C}__${tool}`;

const en = require('../../messages/en.json') as {
    admin: { integrations: { passport: Record<string, string> } };
};
const P = en.admin.integrations.passport;

const pin = (tool: string, over: Partial<IntegrationPassportView['current']['pinnedTools'][number]> = {}) => ({
    toolName: q(tool),
    descriptionHash: 'd'.repeat(64),
    schemaHash: 's'.repeat(64),
    manifestHash: 'm'.repeat(64),
    annotationsHash: 'a'.repeat(64),
    revision: 2,
    approvalSource: 'APPROVED',
    approvedByUserId: 'user-approver',
    approvedAt: '2026-10-01T09:00:00.000Z',
    previousManifestHash: null,
    declaresWrite: false,
    ...over,
});

function view(over: {
    current?: Partial<IntegrationPassportView['current']>;
    view?: Partial<Omit<IntegrationPassportView, 'current'>>;
} = {}): IntegrationPassportView {
    const current: IntegrationPassportView['current'] = {
        connectionId: C,
        name: 'Ticketing',
        endpoint: { origin: 'https://tickets.example.test', urlDigest: 'u'.repeat(64) },
        enabled: true,
        grantKind: 'delegated',
        scope: { stored: null, effective: 'api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default offline_access', defaulted: true },
        audience: ['api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4'],
        pinnedTools: [
            pin('lookup'),
            pin('close_ticket', { declaresWrite: true }),
            pin('reopen_ticket', { declaresWrite: true }),
        ],
        grantedAgents: [
            { agentId: 'agent-1', toolName: q('lookup'), grantedByUserId: 'user-granter', createdAt: '2026-10-02T09:00:00.000Z' },
        ],
        writeRung: { mode: 'DRY_RUN', storedUnrecognised: null, since: '2026-10-03T09:00:00.000Z' },
        // `reopen_ticket` is paired; `close_ticket` is not.
        priorStatePairings: [
            { writeToolName: q('reopen_ticket'), readToolName: q('lookup'), approvedByUserId: 'user-owner', updatedAt: '2026-10-04T09:00:00.000Z' },
        ],
        parameterSets: [],
        owner: { userId: 'user-owner', accountable: true },
        lastValidated: { at: '2026-10-05T09:00:00.000Z', status: 'ok' },
        digest: 'f'.repeat(64),
        ...over.current,
    };
    const declaredWrite = current.pinnedTools
        .filter((p) => p.declaresWrite === true)
        .map((p) => ({
            toolName: p.toolName,
            hasPairing: current.priorStatePairings.some((x) => x.writeToolName === p.toolName),
        }));
    return {
        current,
        writeDeclarations: {
            declaredWrite,
            declarationNotRecorded: current.pinnedTools.filter((p) => p.declaresWrite === null).map((p) => p.toolName),
        },
        lastEmitted: { periodLabel: '2026-W41', verified: true, reason: null, unchangedSince: true },
        changes: [],
        openFindings: [],
        owner: { userId: 'user-owner', name: 'Olga Owner', email: 'olga@example.test' },
        ...over.view,
    };
}

let calls: string[] = [];
let respond: () => { ok: boolean; status: number; json: () => Promise<unknown> };
const realFetch = global.fetch;

beforeEach(() => {
    calls = [];
    respond = () => ({ ok: true, status: 200, json: async () => view() });
    // Plain `{ ok, status, json }` objects: this jsdom has no usable Response
    // (the house pattern, see legacy-mapping-card.test.tsx).
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return respond();
    }) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = realFetch;
});

async function renderLoaded() {
    const utils = render(<IntegrationPassportCard connectionId={C} />);
    await waitFor(() => expect(screen.getByTestId('integration-passport')).toBeInTheDocument());
    return utils;
}

describe('IntegrationPassportCard — the fields', () => {
    it('reads the OWNER-only sibling route, not a path under admin/integrations', async () => {
        await renderLoaded();
        expect(calls).toEqual([`/api/t/acme/admin/integration-passport/${C}`]);
    });

    it('renders P1–P5, P8 and P12 from the server answer', async () => {
        await renderLoaded();
        expect(screen.getByTestId('passport-field-endpoint')).toHaveTextContent('https://tickets.example.test');
        expect(screen.getByTestId('passport-field-endpoint')).toHaveTextContent(P.endpointOriginOnly);
        expect(screen.getByTestId('passport-field-grant')).toHaveTextContent('delegated');
        expect(screen.getByTestId('passport-field-scope')).toHaveTextContent(P.scopeDefaulted);
        expect(screen.getByTestId('passport-field-audience')).toHaveTextContent('api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4');
        expect(screen.getByTestId('passport-field-rung')).toHaveTextContent('DRY_RUN');
        expect(screen.getByTestId('passport-field-validated')).not.toHaveTextContent(P.neverTested);
        expect(screen.getByTestId('passport-emission')).toHaveTextContent('Digest ffffffffffff');
        expect(screen.getByTestId('passport-emission')).toHaveTextContent('Last emitted for 2026-W41; unchanged since');
    });

    it('shows the pinned tools by their bare name, never the stored prefix', async () => {
        await renderLoaded();
        const pins = screen.getByTestId('passport-pins-table');
        expect(within(pins).getByText('lookup')).toBeInTheDocument();
        expect(within(pins).getByText('close_ticket')).toBeInTheDocument();
        expect(pins.textContent).not.toContain(`mcp__${C}__`);
    });

    it('says a connection was never tested, and that a grant mints no token', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({
                current: {
                    grantKind: 'static-header',
                    scope: { stored: 'api://x/.default', effective: null, defaulted: false },
                    audience: 'unknown',
                    lastValidated: { at: null, status: null },
                },
            }),
        });
        await renderLoaded();
        expect(screen.getByTestId('passport-never-tested')).toHaveTextContent(P.neverTested);
        expect(screen.getByTestId('passport-field-scope')).toHaveTextContent(P.scopeNotMinted);
        expect(screen.getByTestId('passport-field-audience')).toHaveTextContent(P.audienceUnknown);
    });
});

describe('IntegrationPassportCard — the owner', () => {
    it('names the accountable owner when there is one, and shows no warning', async () => {
        await renderLoaded();
        expect(screen.getByTestId('passport-owner')).toHaveTextContent('Accountable owner: Olga Owner');
        expect(screen.queryByTestId('passport-owner-missing')).toBeNull();
    });

    it('warns that findings go to the tenant’s owners when no owner is named', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({ current: { owner: { userId: null, accountable: false } }, view: { owner: null } }),
        });
        await renderLoaded();
        expect(screen.getByTestId('passport-owner-missing')).toHaveTextContent(P.ownerMissing);
        expect(screen.queryByTestId('passport-owner')).toBeNull();
    });

    it('tells a named owner who LEFT apart from an owner never named', async () => {
        // P11 `accountable` is false when the named user holds no ACTIVE
        // membership. The display lookup may still find the person, so the card
        // must decide from `accountable`, not from whether a name came back.
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({ current: { owner: { userId: 'user-left', accountable: false } } }),
        });
        await renderLoaded();
        expect(screen.getByTestId('passport-owner-missing')).toHaveTextContent(P.ownerInactive);
        expect(screen.queryByTestId('passport-owner')).toBeNull();
    });
});

describe('IntegrationPassportCard — the write declaration', () => {
    it('marks a declared-write tool with no prior-state pairing, and only that one', async () => {
        await renderLoaded();
        expect(screen.getByTestId('passport-unpaired-writes')).toHaveTextContent('close_ticket');
        expect(screen.getByTestId('passport-unpaired-writes')).not.toHaveTextContent('reopen_ticket');
        expect(screen.getByTestId('passport-unpaired-close_ticket')).toHaveTextContent(P.writeUnpaired);
        expect(screen.queryByTestId('passport-unpaired-reopen_ticket')).toBeNull();
    });

    it('raises no marker when every declared write is paired', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({ current: { pinnedTools: [pin('lookup'), pin('reopen_ticket', { declaresWrite: true })] } }),
        });
        await renderLoaded();
        expect(screen.queryByTestId('passport-unpaired-writes')).toBeNull();
    });

    it('lists the pins whose declaration was never recorded', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({ current: { pinnedTools: [pin('lookup', { declaresWrite: null })] } }),
        });
        await renderLoaded();
        expect(screen.getByTestId('passport-declaration-not-recorded')).toHaveTextContent('lookup');
    });
});

describe('IntegrationPassportCard — the comparison', () => {
    it('lists what the next sweep would raise, and links the open findings', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({
                view: {
                    lastEmitted: { periodLabel: '2026-W41', verified: true, reason: null, unchangedSince: false },
                    changes: [{ code: 'PIN_CHANGED', severity: 'HIGH', field: 'P6', item: q('close_ticket') }],
                    openFindings: [{
                        id: 'finding-9', title: 'Integration passport — PIN_BASELINE — Ticketing (conn_1)',
                        severity: 'HIGH', status: 'OPEN', sourceRef: `${C}:P6:BASELINE:close_ticket`, assigneeUserId: null,
                    }],
                },
            }),
        });
        await renderLoaded();
        const changes = screen.getByTestId('passport-changes');
        expect(within(changes).getByText('PIN_CHANGED')).toBeInTheDocument();
        expect(within(changes).getByText('close_ticket')).toBeInTheDocument();
        const link = within(screen.getByTestId('passport-findings')).getByRole('link');
        expect(link).toHaveAttribute('href', '/t/acme/findings/finding-9');
        expect(within(screen.getByTestId('passport-findings')).getByText(P.findingOwnerRole)).toBeInTheDocument();
    });

    it('says plainly when the last emission could not be verified', async () => {
        respond = () => ({
            ok: true, status: 200,
            json: async () => view({
                view: { lastEmitted: { periodLabel: '2026-W41', verified: false, reason: 'DIGEST_MISMATCH', unchangedSince: false } },
            }),
        });
        await renderLoaded();
        expect(screen.getByTestId('passport-prior-unverifiable')).toHaveTextContent('DIGEST_MISMATCH');
        expect(screen.getByTestId('passport-changes')).toHaveTextContent(P.changesNoPrior);
    });
});

describe('IntegrationPassportCard — when there is no passport', () => {
    it.each([404, 403])('renders NOTHING on a %i', async (status) => {
        respond = () => ({ ok: false, status, json: async () => ({ error: 'x' }) });
        const { container } = render(<IntegrationPassportCard connectionId={C} />);
        await waitFor(() => expect(calls).toHaveLength(1));
        // Let the resolved fetch settle into state before asserting absence —
        // an assertion made while the request is outstanding would pass for a
        // card that renders an error a moment later.
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(container).toBeEmptyDOMElement();
    });

    it('shows a load error, rather than nothing, on any other failure', async () => {
        respond = () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) });
        render(<IntegrationPassportCard connectionId={C} />);
        await waitFor(() => expect(screen.getByTestId('passport-load-error')).toHaveTextContent(P.loadError));
    });
});
