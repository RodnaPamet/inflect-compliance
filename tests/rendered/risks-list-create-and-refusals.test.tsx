/**
 * The Risks list offers Create only when the server would accept it, and a
 * refused bulk action shows the server's reason.
 *
 * Create used to follow the coarse write tier alone, while the create and
 * import routes also check `risks.create`, so a custom role without that key
 * saw Create and Import and was refused. The empty state offered its Create
 * button to every role, a Reader included. The AI Assist panel adds risks too,
 * and its routes now take `risks.create` as well (#4327), so it follows the
 * same rule. Which users may create is decided
 * server-side by `riskCanCreate` (tests/unit/risk-bulk-permissions.test.ts
 * maps every role); this file mounts the real client with each outcome.
 *
 * A refused bulk action showed "Bulk action failed" whatever the server
 * said. The reason sits at `error.message` in the API envelope.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);
configure({ asyncUtilTimeout: 20_000 });

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '' : String(v)),
    useModules: () => ({}),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string) => {
            const v = walk(walk(en, ns), key);
            return typeof v === 'string' ? v : key;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/risks',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

// Toasts are asserted by what they were asked to say. The undo-toast runs
// its action at once; the 5-second window is the hook's own concern.
// The table shows 50 rows until it is scrolled, and Select all ticks the
// rows shown, so every row is shown here, as after scrolling to the end.
const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useThresholdLoadMore: <T,>(rows: T[]) => ({ visibleRows: rows, hasMore: false, loadMore: () => {} }),
    useToast: () => ({ error: toastError, success: jest.fn(), warning: jest.fn(), info: jest.fn() }),
    useToastWithUndo: () => (input: {
        action: () => Promise<unknown>;
        onCommit?: (r: unknown) => void;
        onError?: (e: unknown) => void;
    }) => {
        void Promise.resolve()
            .then(() => input.action())
            .then(
                (r) => input.onCommit?.(r),
                (e) => input.onError?.(e),
            );
        return 'undo-toast';
    },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { RisksClient } from '@/app/t/[tenantSlug]/(app)/risks/RisksClient';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

type Props = React.ComponentProps<typeof RisksClient>;
type RiskRow = Props['initialRisks'][number];

const EN = require('../../messages/en.json');
const BULK = EN.risks.bulk;
const FIRST_RUN = EN.panels.riskFirstRun;

const RISK: RiskRow = {
    id: 'risk-1',
    key: 'RSK-1',
    title: 'Ransomware on the file server',
    threat: 'Ransomware',
    likelihood: 3,
    impact: 4,
    inherentScore: 12,
    score: 12,
    treatment: null,
    status: 'OPEN',
    controls: [],
};

const json = (status: number, body: unknown) =>
    ({
        ok: status < 400,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    }) as unknown as Response;

/** The API's refusal envelope, as `toApiErrorResponse` writes it. */
const refusal = (status: number, message: string) =>
    json(status, { error: { code: status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', message, requestId: 'req-1' } });

/** Per-test answers for the bulk routes; anything else answers 200. */
let bulkAnswer: (() => Promise<Response>) | null = null;
let rows: RiskRow[] = [RISK];

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        if (url.pathname.includes('/risks/bulk/') && bulkAnswer) return bulkAnswer();
        return json(200, url.pathname.endsWith('/risks') ? { rows, truncated: false } : {});
    }) as unknown as typeof fetch;
}

const translations = new Proxy({} as Props['translations'], { get: (_t, key) => String(key) });

function mount({ canCreate = true, risks = [RISK] }: { canCreate?: boolean; risks?: RiskRow[] } = {}) {
    rows = risks;
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <RisksClient
                    initialRisks={risks}
                    matrixConfig={DEFAULT_RISK_MATRIX_CONFIG}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true }}
                    bulkPermissions={{ canEdit: true, canDelete: true }}
                    canCreate={canCreate}
                    translations={translations}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

/** Select every row and pick a bulk action by its label. */
async function chooseBulkAction(label: string, firstTitle = RISK.title) {
    await screen.findByText(firstTitle);
    const boxes = await screen.findAllByRole('checkbox');
    await act(async () => {
        fireEvent.click(boxes[0]);
    });
    const select = await waitFor(() => {
        const el = document.getElementById('bulk-action-select');
        if (!el) throw new Error('no bulk bar yet');
        return el;
    });
    fireEvent.click(select);
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: label }));
}

beforeEach(() => {
    bulkAnswer = null;
    toastError.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/risks');
    installFetch();
});

describe('Risks list — Create follows riskCanCreate', () => {
    it('a user who can create gets the Create button', async () => {
        mount({ canCreate: true });
        await screen.findByText(RISK.title);
        expect(document.getElementById('new-risk-btn')).not.toBeNull();
    });

    it('a user the create route would refuse gets no Create button', async () => {
        mount({ canCreate: false });
        await screen.findByText(RISK.title);
        expect(document.getElementById('new-risk-btn')).toBeNull();
    });

    // AI Assist adds risks too: its generate and apply routes take
    // `risks.create` (#4327). The mount keeps the write tier on throughout,
    // which is what the panel used to be gated on.
    it('a user who can create gets the AI Assist panel', async () => {
        mount({ canCreate: true });
        await screen.findByText(RISK.title);
        expect(screen.getAllByText(EN.risks.aiAssist).length).toBeGreaterThan(0);
        expect(screen.getAllByTestId('aside-panel-sheet-trigger').length).toBeGreaterThan(0);
    });

    it('a user the AI routes would refuse gets no AI Assist panel, even with the write tier', async () => {
        mount({ canCreate: false });
        await screen.findByText(RISK.title);
        expect(screen.queryAllByText(EN.risks.aiAssist)).toHaveLength(0);
        expect(screen.queryAllByTestId('aside-panel-sheet-trigger')).toHaveLength(0);
        expect(screen.queryAllByTestId('aside-panel-spine')).toHaveLength(0);
    });

    it('the empty register offers its Create button only to a user who can create', async () => {
        const view = mount({ canCreate: true, risks: [] });
        await screen.findByText(FIRST_RUN.title);
        expect(screen.getByTestId('risk-first-run-cta')).toBeInTheDocument();
        view.unmount();

        mount({ canCreate: false, risks: [] });
        await screen.findByText(FIRST_RUN.title);
        expect(screen.queryByTestId('risk-first-run-cta')).toBeNull();
        expect(screen.queryByText(FIRST_RUN.cta)).toBeNull();
    });
});

describe('Risks list — a refused bulk action shows the server’s reason', () => {
    it('Assign owner', async () => {
        const reason = 'Owner must be an active member of this tenant';
        bulkAnswer = async () => refusal(400, reason);
        mount();

        await chooseBulkAction(BULK.assignOwner);
        fireEvent.click(document.getElementById('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
        expect(toastError).not.toHaveBeenCalledWith(BULK.actionFailed);
    });

    it('Delete, once the undo window has run', async () => {
        const reason = 'You do not have permission to perform this action';
        bulkAnswer = async () => refusal(403, reason);
        mount();

        await chooseBulkAction(BULK.delete);
        fireEvent.click(document.getElementById('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
        expect(toastError).not.toHaveBeenCalledWith(BULK.actionFailed);
    });

    it('a request that never reached the server falls back to the generic text', async () => {
        bulkAnswer = async () => {
            throw new TypeError('Failed to fetch');
        };
        mount();

        await chooseBulkAction(BULK.assignOwner);
        fireEvent.click(document.getElementById('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(BULK.actionFailed));
        expect(toastError).not.toHaveBeenCalledWith('Failed to fetch');
    });

    it('a selection larger than the bulk routes accept is stopped before it is sent', async () => {
        const many = Array.from({ length: 101 }, (_, i) => ({
            ...RISK,
            id: `risk-${i}`,
            key: `RSK-${i}`,
            title: `Risk ${String(i).padStart(3, '0')}`,
        }));
        bulkAnswer = async () => json(200, {});
        mount({ risks: many });

        await chooseBulkAction(BULK.delete, 'Risk 000');
        // Every row and the header box.
        await waitFor(() =>
            expect(screen.getAllByRole('checkbox', { checked: true }).length).toBeGreaterThanOrEqual(102),
        );
        fireEvent.click(document.getElementById('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(BULK.tooMany));
        const calls = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u));
        expect(calls.filter((u) => u.includes('/risks/bulk/'))).toEqual([]);
    });

    it('a refusal with no reason falls back to the generic text', async () => {
        bulkAnswer = async () => json(500, {});
        mount();

        await chooseBulkAction(BULK.delete);
        fireEvent.click(document.getElementById('bulk-apply-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(BULK.actionFailed));
    });
});
