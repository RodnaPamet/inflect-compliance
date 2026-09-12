/**
 * REVOKING A TOOL GRANT SCHEDULES, IT DOES NOT COMMIT (#2453).
 *
 * `AgentToolGrant` has NO soft-delete rail: a revoke deletes the row, and
 * re-granting is a new grant by a new actor at a new time. So the undo window is
 * not a convenience — it is the only thing that preserves the original
 * `grantedByUserId` and `createdAt`, which is exactly what an auditor asks about
 * a grant that was taken back and put back.
 *
 * ── WHAT THESE ASSERT, AND WHY EACH IS NEEDED ───────────────────────
 *
 * A test that only checked "Undo restores the row" would pass against a UI that
 * DELETED immediately and then re-created on undo — which is the failure this
 * rail exists to prevent, because the re-created row carries new provenance.
 * So the load-bearing assertion is the NEGATIVE one: no DELETE reaches the
 * server during the window, and none ever reaches it if Undo is pressed.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

interface CustomCall { id: number; factory: (id: number) => React.ReactElement }
const customCalls: CustomCall[] = [];
let nextSonnerId = 1;

// `useToastWithUndo` calls `toast.custom((id) => <UndoToast …/>)` synchronously
// from the trigger. Capture the factory so the Undo button is reachable.
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((msg: string) => msg, {
        custom: (factory: (id: number) => React.ReactElement) => {
            const id = nextSonnerId++;
            customCalls.push({ id, factory });
            return id;
        },
        dismiss: (id: string | number) => id,
        success: jest.fn(), error: jest.fn(), warning: jest.fn(),
        info: jest.fn(), message: jest.fn(), loading: jest.fn(),
    }),
}));

// Radix's tooltip provider spins its own timers; under fake timers it never
// settles and the file times out on something it is not about.
jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: () => null,
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
            return v;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mutate = jest.fn(async () => undefined);
let payload: unknown;
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: unknown) =>
        typeof key === 'string' && key.includes('tool-manifests')
            ? { data: [], error: undefined, isLoading: false, mutate }
            : { data: payload, error: undefined, isLoading: false, mutate },
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

import { ToolsTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ToolsTab';

const TOOL = 'list_risks';

function grantsPayload() {
    return {
        granted: [
            { id: 'g1', toolName: TOOL, grantedByUserId: 'user-7', createdAt: '2026-09-01T10:00:00.000Z' },
        ],
        catalogue: [{ name: TOOL, description: 'List risks', scope: 'read' }],
    };
}

let fetchMock: jest.Mock;

beforeEach(() => {
    customCalls.length = 0;
    nextSonnerId = 1;
    payload = grantsPayload();
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.useFakeTimers();
});

afterEach(() => {
    if (jest.isMockFunction(setTimeout)) jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

function renderTab() {
    return render(<ToolsTab tenantSlug="acme" agentId="agent-1" canGrantTools onChanged={jest.fn()} />);
}

/** The DELETE the revoke would make, if it made one. */
function deleteCalls() {
    return fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE');
}

describe('revoke schedules rather than commits', () => {
    it('sends NO request when the button is pressed', async () => {
        renderTab();
        fireEvent.click(await screen.findByTestId(`agent-tool-revoke-${TOOL}`));
        // The load-bearing negative. A UI that deleted immediately and
        // re-created on undo would pass "Undo restores the row" and lose the
        // grant's original provenance.
        expect(deleteCalls()).toHaveLength(0);
    });

    it('commits once the window elapses', async () => {
        renderTab();
        fireEvent.click(await screen.findByTestId(`agent-tool-revoke-${TOOL}`));
        await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
        await waitFor(() => expect(deleteCalls().length).toBe(1));
        expect(String(deleteCalls()[0][0])).toContain(encodeURIComponent(TOOL));
    });
});

describe('Undo cancels, and the grant survives', () => {
    it('never sends the DELETE when Undo is pressed', async () => {
        renderTab();
        fireEvent.click(await screen.findByTestId(`agent-tool-revoke-${TOOL}`));

        // Render the captured undo toast and press its action.
        expect(customCalls.length).toBeGreaterThan(0);
        // Scoped to the toast's OWN container: an unscoped query matches the
        // tab's buttons too, since both render into the same document.
        const toastUi = render(customCalls[customCalls.length - 1].factory(1));
        fireEvent.click(within(toastUi.container).getByRole('button'));

        await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
        expect(deleteCalls()).toHaveLength(0);
    });
});
