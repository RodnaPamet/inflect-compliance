/** @jest-environment jsdom */

/**
 * THE REGISTER ACTION ON THE SHADOW LIST (#3712), rendered.
 *
 *   1. THE ACTION IS OFFERED ONLY WHERE THE INTAKE WOULD TAKE IT: the server
 *      said this caller may run the intake, the row has a SHADOW_AGENT finding
 *      to register from, and no intake row was made from the agent before. A
 *      row that has one says what became of it instead.
 *   2. THE FORM REFUSES WITHOUT A CONFIRMED, ACTIVE OWNER, AND NEVER PRE-FILLS
 *      THE OWNER FROM THE SUGGESTION. The picker reads the ACTIVE roster
 *      (`/users/assignable`) and starts empty with a suggestion on screen; the
 *      confirmation names nobody until a person is chosen and is cleared when
 *      the choice changes; the submit waits for both.
 *   3. NO EXPOSURE AXIS IS PRE-SELECTED, and a third-party agent needs its
 *      supplier.
 *   4. THE BODY IS EXACTLY WHAT THE STRICT SCHEMA TAKES, and the API's refusal
 *      is shown in the dialog, which stays open.
 *
 * The real `<UserCombobox>`, `<Combobox>`, `<Checkbox>` and `<RadioGroup>` are
 * driven; only `fetch` answers.
 */
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

// next-intl is ESM; resolve real en.json values, memoised per namespace.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh, back: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams('tab=harness'),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// `ReportsClient` loads the harness tab through `next/dynamic`; the tab is
// under test, not the loading boundary, so it is answered synchronously.
jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => require('@/app/t/[tenantSlug]/(app)/agents/reports/harness/HarnessTab').HarnessTab,
}));

import { SWRConfig } from 'swr';
import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import {
    intakeRequestBody,
    RegisterShadowAgentModal,
    type IntakeDraft,
    type IntakeSuggestionView,
} from '@/app/t/[tenantSlug]/(app)/agents/reports/harness/RegisterShadowAgentModal';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';
import type { HarnessMatrixView, HarnessScanRow, ShadowRow } from '@/lib/agentic/harness-read-model';

const EN = jest.requireActual('../../messages/en.json') as {
    agents: {
        harness: Record<string, string> & { registerModal: Record<string, string> };
        register: { new: Record<string, string>; filterEnums: { accessScope: Record<string, string> }; reversibility: Record<string, string> };
    };
};
const H = EN.agents.harness;
const R = H.registerModal;
const NEW = EN.agents.register.new;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LATEST: HarnessScanRow = {
    id: 'scan_latest',
    scanRef: 'ref-latest',
    scannerAgentId: 'agt_scanner',
    scannerName: 'Estate scanner',
    scannerVersion: '1.2.0',
    asOf: '2026-10-15T03:00:00.000Z',
    ingestedAt: '2026-10-15T03:05:00.000Z',
    completeness: 'COMPLETE',
    agentCount: 4,
    sources: [{ kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null }],
};

const shadowRow = (over: Partial<ShadowRow> = {}): ShadowRow => ({
    discoveredAgentId: 'da_open',
    discoveredId: 'entra:sp:open',
    discoveredVia: ['entra-sp'],
    firstSeenAt: '2026-10-14T03:00:00.000Z',
    lastSeenAt: '2026-10-15T03:00:00.000Z',
    lastLevel: 'H0',
    reason: 'UNREGISTERED',
    findingId: 'fnd_open',
    intake: null,
    ...over,
});

const ROWS: ShadowRow[] = [
    shadowRow(),
    shadowRow({
        discoveredAgentId: 'da_pending',
        discoveredId: 'entra:sp:pending',
        findingId: 'fnd_pending',
        intake: { agentId: 'agt_pending', name: 'Sales bot', linkable: true },
    }),
    shadowRow({
        discoveredAgentId: 'da_retired',
        discoveredId: 'entra:sp:retired',
        findingId: 'fnd_retired',
        intake: { agentId: 'agt_retired', name: 'Old bot', linkable: false },
    }),
    shadowRow({ discoveredAgentId: 'da_nofinding', discoveredId: 'entra:sp:nofinding', findingId: null }),
];

const view = (rows: ShadowRow[] = ROWS): HarnessMatrixView => ({
    generatedAt: '2026-10-17T09:00:00.000Z',
    scanWindow: 50,
    scans: { rows: [LATEST], truncated: false },
    sections: [],
    scannersNotShown: 0,
    scannersWithoutScan: { rows: [], truncated: false },
    shadow: { rows, truncated: false, basis: 'EVIDENCED', basisAsOf: LATEST.asOf },
    acceptances: { rows: [], truncated: false },
});

function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>{children}</TenantProvider>
        </SWRConfig>
    );
}

const renderTab = (canRegisterShadow?: boolean) =>
    render(
        <Providers>
            <ReportsClient
                tab="harness"
                tenantSlug="acme"
                harness={view()}
                scannerKeys={{ keys: { rows: [], truncated: false }, candidates: { rows: [], truncated: false } }}
                // No estate declared (#3678): the estate card is its own suite's.
                estateHealth={{ generatedAt: '2026-10-19T00:00:00.000Z', scanWindow: 500, windowTruncated: false, estates: { rows: [], truncated: false } }}
                {...(canRegisterShadow === undefined ? {} : { canRegisterShadow })}
                canReviewProposals
                canInvestigate
                canExport={false}
            />
        </Providers>,
    );

const SUGGESTION: IntakeSuggestionView = {
    status: 'SUGGESTED',
    grade: 'STRONG',
    unmatchedReason: null,
    signals: [
        { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/open#owners', namesPerson: true },
        { kind: 'NAMING_PATTERN', evidence: 'entra-sp:servicePrincipals/open#displayName', namesPerson: false },
    ],
};

const renderModal = (suggestion: IntakeSuggestionView | null = null, onClose = jest.fn()) =>
    render(
        <Providers>
            <RegisterShadowAgentModal target={shadowRow()} suggestion={suggestion} onClose={onClose} />
        </Providers>,
    );

// ─── fetch ──────────────────────────────────────────────────────────────────

const MEMBERS = [
    { id: 'u_ada', name: 'Ada Active', email: 'ada@acme.test', image: null },
    { id: 'u_bob', name: 'Bob Active', email: 'bob@acme.test', image: null },
];
let calls: { url: string; method: string; body: unknown }[] = [];
let intakeResponse: () => { status: number; body: unknown } = () => ({ status: 201, body: { agentId: 'agt_new' } });
const realFetch = global.fetch;

beforeEach(() => {
    calls = [];
    intakeResponse = () => ({ status: 201, body: { agentId: 'agt_new', status: 'DRAFT', aiActRiskTier: 'UNCLASSIFIED' } });
    mockRefresh.mockReset();
    Object.values(mockToast).forEach((f) => f.mockReset());
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        const json = (status: number, body: unknown) =>
            ({ ok: status < 400, status, json: async () => body }) as Response;
        if (url.endsWith('/users/assignable')) return json(200, MEMBERS);
        if (url.endsWith('/vendors')) return json(200, { rows: [{ id: 'vnd_1', name: 'Bot Vendor Ltd' }], truncated: false });
        if (url.endsWith('/admin/agents/intake')) {
            const r = intakeResponse();
            return json(r.status, r.body);
        }
        return json(404, {});
    }) as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

// ─── helpers ────────────────────────────────────────────────────────────────

type User = ReturnType<typeof userEvent.setup>;
const submit = () => screen.getByTestId('harness-register-submit');
const confirmBox = () => document.getElementById('harness-register-confirm')!;

async function choose(user: User, triggerId: string, label: string | RegExp) {
    await user.click(document.getElementById(triggerId)!);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: label }));
}

/** Everything but the owner and its confirmation. */
async function fillAgent(user: User) {
    await user.type(document.getElementById('harness-register-name')!, 'Sales bot');
    await choose(user, 'harness-register-autonomy', '3');
    await choose(user, 'harness-register-access', EN.agents.register.filterEnums.accessScope.WRITE_TENANT_DATA);
    await user.click(document.getElementById('harness-register-reversibility-COMPENSABLE')!);
    await user.click(document.getElementById('harness-register-provenance-FIRST_PARTY')!);
}

// ─── 1. Where the action is offered ─────────────────────────────────────────

describe('the Register action is offered only where the intake would take it', () => {
    it('a row with a finding and no intake row offers it; the others say why not', () => {
        renderTab(true);
        expect(screen.getByTestId('harness-shadow-register-da_open').textContent).toBe(H.register);
        for (const id of ['da_pending', 'da_retired', 'da_nofinding']) {
            expect(screen.queryByTestId(`harness-shadow-register-${id}`)).not.toBeInTheDocument();
        }
        expect(screen.getByTestId('harness-shadow-intake-da_pending').textContent).toBe(
            H.shadowIntakePending.replace('{name}', 'Sales bot'),
        );
        expect(screen.getByTestId('harness-shadow-intake-da_retired').textContent).toBe(H.shadowIntakeRetired);
        expect(screen.getByTestId('harness-shadow-no-finding-da_nofinding').textContent).toBe(H.shadowNoFinding);
    });

    it('a caller the server did not clear for the intake is offered it nowhere — and absent is not yes', () => {
        for (const flag of [false, undefined]) {
            const { unmount } = renderTab(flag);
            // Positive anchor: the list rendered, with the notes that need no permission.
            expect(screen.getByTestId('harness-shadow-table')).toBeInTheDocument();
            expect(screen.getByTestId('harness-shadow-intake-da_pending')).toBeInTheDocument();
            expect(screen.queryByTestId('harness-shadow-register-da_open')).not.toBeInTheDocument();
            unmount();
        }
    });

    it('the action opens the dialog for that row', async () => {
        const user = userEvent.setup();
        renderTab(true);
        await user.click(screen.getByTestId('harness-shadow-register-da_open'));
        expect(screen.getByTestId('harness-register-modal')).toBeInTheDocument();
        expect(screen.getByText(R.description.replace('{agent}', 'entra:sp:open'))).toBeInTheDocument();
    });
});

// ─── 2. The owner ───────────────────────────────────────────────────────────

describe('the register form refuses without a confirmed, ACTIVE owner, and never pre-fills it from the suggestion', () => {
    it('with a suggestion on screen the owner starts empty, and nothing is sendable until a person is chosen AND confirmed', async () => {
        const user = userEvent.setup();
        renderModal(SUGGESTION);

        // The suggestion is shown, as provenance only: what it rested on.
        const shown = screen.getByTestId('harness-register-suggestion');
        expect(shown.textContent).toContain(R.suggestionSuggested.replace('{grade}', R.gradeStrong));
        expect(shown.textContent).toContain('entra-sp:servicePrincipals/open#owners');
        expect(shown.textContent).toContain(R.suggestionNever);

        // The picker reads the ACTIVE roster and selects nobody.
        await waitFor(() => expect(calls.some((c) => c.url === '/api/t/acme/users/assignable')).toBe(true));
        expect(document.getElementById('harness-register-owner')?.textContent).toContain(NEW.ownerPlaceholder);
        expect(confirmBox()).toBeDisabled();
        expect(confirmBox().getAttribute('aria-checked')).toBe('false');
        expect(screen.getByText(R.confirmNeedsOwner)).toBeInTheDocument();

        await fillAgent(user);
        expect(submit()).toBeDisabled();

        // A chosen owner is not yet a confirmed one.
        await choose(user, 'harness-register-owner', /Ada Active/);
        expect(screen.getByText(R.confirmLabel.replace('{owner}', 'Ada Active'))).toBeInTheDocument();
        expect(confirmBox()).toBeEnabled();
        expect(submit()).toBeDisabled();

        await user.click(confirmBox());
        expect(submit()).toBeEnabled();

        // Choosing somebody else clears the confirmation: it was of Ada.
        await choose(user, 'harness-register-owner', /Bob Active/);
        expect(confirmBox().getAttribute('aria-checked')).toBe('false');
        expect(submit()).toBeDisabled();
        expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it('an owner the server finds not ACTIVE is refused in the dialog, which stays open', async () => {
        const refusal = 'The confirmed owner must be an active member of this workspace.';
        intakeResponse = () => ({
            status: 400,
            body: { error: { code: 'VALIDATION_ERROR', message: refusal, details: { reason: 'OWNER_NOT_ACTIVE_MEMBER' } } },
        });
        const user = userEvent.setup();
        const onClose = jest.fn();
        renderModal(null, onClose);
        await fillAgent(user);
        await choose(user, 'harness-register-owner', /Ada Active/);
        await user.click(confirmBox());
        await user.click(submit());

        await waitFor(() => expect(screen.getByTestId('harness-register-error').textContent).toContain(refusal));
        expect(screen.getByTestId('harness-register-modal')).toBeInTheDocument();
        expect(mockToast.error.mock.calls[0][0]).toBe(refusal);
        expect(onClose).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('the body builder has no owner without a person and a confirmation', () => {
        const draft: IntakeDraft = {
            ownerUserId: 'u_ada',
            confirmOwner: true,
            name: 'Sales bot',
            description: '',
            autonomyLevel: 3,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            vendorId: null,
            deploymentRole: 'DEPLOYER',
            purpose: '',
        };
        expect(intakeRequestBody('fnd_open', draft)).not.toBeNull();
        expect(intakeRequestBody('fnd_open', { ...draft, ownerUserId: null })).toBeNull();
        expect(intakeRequestBody('fnd_open', { ...draft, confirmOwner: false })).toBeNull();
    });
});

// ─── 3. The axes ────────────────────────────────────────────────────────────

describe('no exposure axis is pre-selected, and a third-party agent needs its supplier', () => {
    it('every axis starts unanswered, and each one is required', () => {
        const base: IntakeDraft = {
            ownerUserId: 'u_ada',
            confirmOwner: true,
            name: 'Sales bot',
            description: '',
            autonomyLevel: 3,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            vendorId: null,
            deploymentRole: 'DEPLOYER',
            purpose: '',
        };
        for (const k of ['autonomyLevel', 'dataAccessScope', 'reversibility', 'provenance'] as const) {
            expect(intakeRequestBody('fnd_open', { ...base, [k]: null })).toBeNull();
        }
        expect(intakeRequestBody('fnd_open', { ...base, name: ' x ' })).toBeNull();
        expect(intakeRequestBody('fnd_open', { ...base, provenance: 'THIRD_PARTY' })).toBeNull();
        expect(intakeRequestBody('fnd_open', { ...base, provenance: 'THIRD_PARTY', vendorId: 'vnd_1' })).toMatchObject({
            provenance: 'THIRD_PARTY',
            vendorId: 'vnd_1',
        });
    });

    it('renders with no axis chosen', () => {
        renderModal();
        expect(document.getElementById('harness-register-autonomy')?.textContent).toContain(R.choose);
        expect(document.getElementById('harness-register-access')?.textContent).toContain(R.choose);
        const radios = within(screen.getByTestId('harness-register-modal')).getAllByRole('radio');
        // Reversibility and provenance unanswered; only the AI-system role has its schema default.
        const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.id);
        expect(checked).toEqual(['harness-register-role-DEPLOYER']);
    });

    it('a third-party agent reads the vendor list and waits for a supplier', async () => {
        const user = userEvent.setup();
        renderModal();
        await user.type(document.getElementById('harness-register-name')!, 'Vendor bot');
        await choose(user, 'harness-register-autonomy', '1');
        await choose(user, 'harness-register-access', EN.agents.register.filterEnums.accessScope.READ_METADATA);
        await user.click(document.getElementById('harness-register-reversibility-REVERSIBLE')!);
        await user.click(document.getElementById('harness-register-provenance-THIRD_PARTY')!);
        await choose(user, 'harness-register-owner', /Ada Active/);
        await user.click(confirmBox());
        expect(submit()).toBeDisabled();

        await waitFor(() => expect(calls.some((c) => c.url === '/api/t/acme/vendors')).toBe(true));
        await choose(user, 'harness-register-vendor', 'Bot Vendor Ltd');
        expect(submit()).toBeEnabled();
        await user.click(submit());
        await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
        expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ provenance: 'THIRD_PARTY', vendorId: 'vnd_1' });
    });
});

// ─── 4. The request ─────────────────────────────────────────────────────────

describe('the request is exactly what the strict schema takes', () => {
    it('posts the finding, the confirmed owner and the declared axes, and nothing else; then refreshes', async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        renderModal(SUGGESTION, onClose);
        await fillAgent(user);
        await choose(user, 'harness-register-owner', /Bob Active/);
        await user.click(confirmBox());
        await user.click(submit());

        await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.url).toBe('/api/t/acme/admin/agents/intake');
        // No tier, no questionnaire, no attribution: exactly these keys.
        expect(post.body).toEqual({
            findingId: 'fnd_open',
            ownerUserId: 'u_bob',
            confirmOwner: true,
            name: 'Sales bot',
            autonomyLevel: 3,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            deploymentRole: 'DEPLOYER',
        });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        expect(onClose).toHaveBeenCalled();
        expect(mockToast.success.mock.calls[0][0]).toBe(R.saved);
    });
});
