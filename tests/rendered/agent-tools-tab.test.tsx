/**
 * Render test for the AGENT TOOLS tab — `ToolsTab` plus the tenant-wide
 * `ToolManifestPins` section it hosts.
 *
 * One tab, TWO resources, and the reason this file exists is that they must
 * fail and gate independently:
 *
 *   • GRANTS — `/admin/agents/:id/tools`, key `admin.agent_tool_exposure`,
 *     per-agent, deny-by-default.
 *   • DEFINITION PINS — `/admin/agents/tool-manifests`, key
 *     `admin.agent_registry` (the key the page already required to open),
 *     TENANT-WIDE.
 *
 * The regression this is written against is the one the tab shipped with and
 * had to be walked back: gating the whole tab on `canGrantTools`, the NARROWER
 * of the two keys. A principal holding only the register key then reached
 * neither half — including the pins, which are the only UI in this product for
 * the OWASP ASI04 tool-poisoning surface, and which that principal is entitled
 * to read. So `!canGrantTools` must put a permission panel where the grants go
 * and leave the pins on screen; and the grants SWR key must be null rather than
 * fired-and-swallowed, because a 403 the UI provoked on purpose is a
 * hash-chained `AUTHZ_DENIED` row in somebody's audit log for a page they only
 * opened.
 *
 * What the pins are watching is the second claim here. A tool definition is a
 * name, a schema and a DESCRIPTION; the description is instruction text handed
 * to the model on every `tools/list` and rendered on no other screen in the
 * product. So a moved `liveDescriptionHash` has to be legible as "the text the
 * model reads was rewritten since somebody reviewed it" — and, just as
 * important, the surface must not say that when it is not true. `status` alone
 * cannot carry the claim: `verifyToolManifest` falls back to
 * `DEFINITION_CHANGED` when the composite digest moved while both component
 * digests sat still, and that row's description demonstrably did NOT change.
 * Rendering the DEFINITION_CHANGED sentence there would be the panel asserting
 * an escalation the API never reported, which is why `movedHalves` recomputes
 * from the digests and why both halves are pinned below.
 *
 * The remaining three, briefly:
 *
 *   • the pins section states its SCOPE in the chrome. A tenant-wide control
 *     that looks per-agent gets read as "this agent's tools", and the reader
 *     then under-estimates an approval by the whole register;
 *   • revoke is not idempotent server-side (`DELETE ?tool=` 404s on a second
 *     click), so the list must be exactly what the payload says is granted and
 *     a 404 must read as "already gone", not as a failed write;
 *   • an agent with zero grants gets the empty state, and that empty state must
 *     not claim the agent can do nothing. `/api/mcp` has a second door —
 *     `resources/read`, audience `mcp:resources` — whose token is not minted
 *     from this list at all.
 *
 * Every absence below is asserted beside something positive from the SAME
 * render, so a component that rendered nothing cannot pass.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` that builds the columns, which turns a
// render into a loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

// The tab is mounted outside the tenant layout, so the provider that resolves
// `/api/t/<slug>` is not in the tree. Only the URL builder is used here.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

const mockToast = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
};
jest.mock('@/components/ui/hooks', () => ({
    // Spread the real barrel: Combobox / CopyText pull useMediaQuery and
    // useCopyToClipboard from it, and only the toast is under observation.
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => mockToast,
}));

import { ApiClientError } from '@/lib/api-client';
import { ToolsTab } from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/ToolsTab';
import {
    TOOL_MANIFEST_PATH,
    type ToolManifestState,
} from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/ToolManifestPins';

/** The real en.json strings the tab renders. */
const EN = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { tools: Record<string, string> } };
    }
).admin.agentDetail.tools;
const PINS = EN.manifests as unknown as {
    heading: string;
    scopeBadge: string;
    intro: string;
    driftCount: string;
    blockedBadge: string;
    noDefinitions: string;
    loadFailedTitle: string;
    approveAction: string;
    explainDefinitionOpaque: string;
    descriptionApproved: string;
    descriptionLive: string;
    descriptionUnchanged: string;
    schemaApproved: string;
    schemaLive: string;
    schemaUnchanged: string;
    manifestLive: string;
    status: Record<string, string>;
    explain: Record<string, string>;
};
const BG = (
    require('../../messages/bg.json') as {
        admin: { agentDetail: { tools: Record<string, string> } };
    }
).admin.agentDetail.tools;
const BG_PINS = BG.manifests as unknown as { explain: Record<string, string> };

const AGENT_ID = 'agent-1';
const GRANTS_PATH = `/admin/agents/${AGENT_ID}/tools`;

// Digests chosen so the first twelve characters — all `shortDigest` renders —
// identify which one is on screen without reading the rest.
const DESC_APPROVED = 'aaaa1111aaaa1111aaaa1111';
const DESC_LIVE = 'bbbb2222bbbb2222bbbb2222';
const SCHEMA_APPROVED = 'cccc3333cccc3333cccc3333';
const SCHEMA_LIVE = 'dddd4444dddd4444dddd4444';
const MANIFEST_APPROVED = 'eeee5555eeee5555eeee5555';
const MANIFEST_LIVE = 'ffff6666ffff6666ffff6666';
const short = (hash: string) => `${hash.slice(0, 12)}…`;

interface Grant {
    id: string;
    toolName: string;
    grantedByUserId: string | null;
    createdAt: string;
}

function grant(toolName: string, id = `grant-${toolName}`): Grant {
    return {
        id,
        toolName,
        grantedByUserId: 'user-7',
        createdAt: '2026-09-01T10:00:00.000Z',
    };
}

function manifest(overrides: Partial<ToolManifestState> = {}): ToolManifestState {
    return {
        toolName: 'list_risks',
        status: 'APPROVED',
        liveManifestHash: MANIFEST_APPROVED,
        liveDescriptionHash: DESC_APPROVED,
        liveSchemaHash: SCHEMA_APPROVED,
        approvedManifestHash: MANIFEST_APPROVED,
        approvedDescriptionHash: DESC_APPROVED,
        approvedSchemaHash: SCHEMA_APPROVED,
        approvalSource: 'APPROVED',
        approvedByUserId: 'user-7',
        approvedAt: '2026-08-01T09:00:00.000Z',
        revision: 3,
        blocked: false,
        ...overrides,
    };
}

const grantsMutate = jest.fn(async () => undefined);
const pinsMutate = jest.fn(async () => undefined);

interface Reads {
    granted?: Grant[];
    available?: string[];
    grantsError?: unknown;
    manifests?: ToolManifestState[];
    manifestsError?: unknown;
}

/**
 * One `useTenantSWR` mock serving THREE call sites — the grants read, the
 * manifest read `ToolsTab` makes to learn which grants the boundary is
 * refusing, and `ToolManifestPins`' own read of the same path. Dispatching on
 * the key is what keeps them independent; a single canned return would make
 * every "one half failed" test below meaningless.
 */
function mockReads({
    granted = [],
    available = ['list_risks', 'list_controls', 'draft_policy'],
    grantsError,
    manifests = [],
    manifestsError,
}: Reads) {
    mockSWR.mockImplementation((key: string | null) => {
        if (key === TOOL_MANIFEST_PATH) {
            return {
                data: manifestsError ? undefined : manifests,
                error: manifestsError,
                isLoading: false,
                mutate: pinsMutate,
            };
        }
        if (key === null) {
            return { data: undefined, error: undefined, isLoading: false, mutate: grantsMutate };
        }
        return {
            data: grantsError ? undefined : { agentId: AGENT_ID, granted, available },
            error: grantsError,
            isLoading: false,
            mutate: grantsMutate,
        };
    });
}

function renderTab(canGrantTools = true) {
    return render(
        <ToolsTab tenantSlug="acme" agentId={AGENT_ID} canGrantTools={canGrantTools} />,
    );
}

/** The `<section>` each `Card as="section"` renders, found by its own heading. */
function sectionOf(heading: string): HTMLElement {
    const el = screen.getByText(heading).closest('section');
    expect(el).not.toBeNull();
    return el as HTMLElement;
}

const grantsSection = () => sectionOf(EN.heading);
const pinsSection = () => sectionOf(PINS.heading);

function installFetch(reply: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = reply(String(input), init);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => r.body ?? null,
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('two resources on one tab, gated and failing independently', () => {
    it('renders the tenant-wide pins in full when the grants key is absent', () => {
        mockReads({
            manifests: [manifest({ toolName: 'list_risks', status: 'UNPINNED', revision: null,
                approvedManifestHash: null, approvedDescriptionHash: null, approvedSchemaHash: null,
                approvalSource: null, approvedByUserId: null, approvedAt: null })],
        });
        renderTab(false);

        // The pins are the whole point of the walk-back: a register-key holder
        // without tool exposure must still reach the ASI04 surface, in full —
        // heading, scope, the row, and the control that acts on it.
        const pins = pinsSection();
        expect(within(pins).getByText(PINS.scopeBadge)).toBeInTheDocument();
        expect(within(pins).getByText('list_risks')).toBeInTheDocument();
        expect(within(pins).getByText(PINS.status.UNPINNED)).toBeInTheDocument();
        expect(within(pins).getByText(PINS.explain.UNPINNED)).toBeInTheDocument();
        expect(screen.getByTestId('tool-manifest-approve-list_risks')).toBeInTheDocument();

        // And the grants half says which authority is missing rather than
        // showing an empty list, which would read as "nothing is granted".
        const grants = grantsSection();
        expect(within(grants).getByText(EN.forbiddenTitle)).toBeInTheDocument();
        expect(within(grants).getByText(EN.forbiddenBody)).toBeInTheDocument();
        expect(screen.queryByTestId('agent-tool-grant-submit')).not.toBeInTheDocument();
        expect(screen.queryByText(EN.noTools)).not.toBeInTheDocument();
    });

    it('nulls the grants key rather than firing a read it knows will 403', () => {
        mockReads({ manifests: [manifest()] });
        renderTab(false);

        const keys = mockSWR.mock.calls.map((c) => c[0]);
        // The manifest read is fired unconditionally — it is gated on the
        // register key, which every mount of this page already holds.
        expect(keys).toContain(TOOL_MANIFEST_PATH);
        expect(keys).toContain(null);
        expect(keys).not.toContain(GRANTS_PATH);
    });

    it('renders both halves when the principal holds both keys', () => {
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        renderTab(true);

        // The companion to the two tests above: the grants half is not simply
        // absent from this component, and the pins are not conditional on it.
        expect(screen.getByTestId('agent-tool-row-list_risks')).toBeInTheDocument();
        expect(screen.getByTestId('agent-tool-grant-submit')).toBeInTheDocument();
        expect(screen.getByText(PINS.heading)).toBeInTheDocument();
        expect(mockSWR.mock.calls.map((c) => c[0])).toContain(GRANTS_PATH);
        expect(screen.queryByText(EN.forbiddenTitle)).not.toBeInTheDocument();
    });

    it('keeps the pins on screen when the GRANTS read 403s', () => {
        mockReads({
            grantsError: new ApiClientError('nope', 'FORBIDDEN', 403),
            manifests: [manifest({ toolName: 'draft_policy' })],
        });
        renderTab(true);

        expect(within(grantsSection()).getByText(EN.forbiddenTitle)).toBeInTheDocument();
        expect(within(pinsSection()).getByText('draft_policy')).toBeInTheDocument();
        // The settled-row sentence, not the badge: "Approved" is also the
        // label on the `approvedAt` fact, so the badge text alone is ambiguous.
        expect(within(pinsSection()).getByText(PINS.explain.APPROVED)).toBeInTheDocument();
    });

    it('keeps the grants list on screen when the PINS read fails, and says the boundary was not checked', () => {
        mockReads({
            granted: [grant('list_risks')],
            manifestsError: new ApiClientError('boom', 'INTERNAL', 500),
        });
        renderTab(true);

        // The grant list survives its sibling's failure...
        expect(screen.getByTestId('agent-tool-row-list_risks')).toBeInTheDocument();
        expect(screen.getByText(PINS.loadFailedTitle)).toBeInTheDocument();
        // ...and refuses to let an absent "refused at the boundary" badge read
        // as "checked, and fine". It was not checked.
        expect(screen.getByText(EN.blockedUnknown)).toBeInTheDocument();
        expect(screen.queryByTestId('agent-tool-blocked-list_risks')).not.toBeInTheDocument();
    });
});

describe('the pins section says it is TENANT-WIDE, not this agent', () => {
    it('carries the scope badge and the scope sentence in its own chrome', () => {
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        renderTab(true);

        const pins = pinsSection();
        expect(within(pins).getByText(PINS.scopeBadge)).toBeInTheDocument();
        expect(within(pins).getByText(PINS.intro)).toBeInTheDocument();

        // The badge belongs to the pins, not to the per-agent half — a scope
        // marker that drifted into the grants card would say the opposite of
        // what is true about both sections.
        const grants = grantsSection();
        expect(within(grants).getByText(EN.heading)).toBeInTheDocument();
        expect(within(grants).queryByText(PINS.scopeBadge)).not.toBeInTheDocument();
        expect(grants).not.toBe(pins);
    });

    it('states the reach in words as well as in a badge', () => {
        // The badge is two words and easy to skim past; the sentence under it
        // is what an operator reads before approving. Both locales, because the
        // section renders in whichever one the tenant reads.
        expect(PINS.intro).toMatch(/every agent/i);
        expect((BG.manifests as unknown as { intro: string }).intro).toMatch(/всички агенти/);
    });
});

describe('a moved description digest is legible as the instruction text moving', () => {
    const drifted = manifest({
        toolName: 'list_risks',
        status: 'DESCRIPTION_CHANGED',
        approvedDescriptionHash: DESC_APPROVED,
        liveDescriptionHash: DESC_LIVE,
        approvedSchemaHash: SCHEMA_APPROVED,
        liveSchemaHash: SCHEMA_APPROVED,
        approvedManifestHash: MANIFEST_APPROVED,
        liveManifestHash: MANIFEST_LIVE,
    });

    it('names the drift, shows both description digests, and says the schema sat still', () => {
        mockReads({ manifests: [drifted] });
        renderTab(true);

        const pins = pinsSection();
        expect(within(pins).getByText(PINS.status.DESCRIPTION_CHANGED)).toBeInTheDocument();
        expect(within(pins).getByText(PINS.explain.DESCRIPTION_CHANGED)).toBeInTheDocument();

        // Two digests for the half that moved — an operator compares them.
        expect(within(pins).getByText(PINS.descriptionApproved)).toBeInTheDocument();
        expect(within(pins).getByText(short(DESC_APPROVED))).toBeInTheDocument();
        expect(within(pins).getByText(PINS.descriptionLive)).toBeInTheDocument();
        expect(within(pins).getByText(short(DESC_LIVE))).toBeInTheDocument();

        // One labelled unchanged for the half that did not. An absent row reads
        // as "not checked", and "the schema sat still" is half the reason the
        // description moving is worth escalating.
        expect(within(pins).getByText(PINS.schemaUnchanged)).toBeInTheDocument();
        expect(within(pins).queryByText(PINS.schemaApproved)).not.toBeInTheDocument();
        expect(within(pins).queryByText(PINS.schemaLive)).not.toBeInTheDocument();
    });

    it('the drift row leads, whatever its name sorts to', () => {
        // The population is every tool the build defines and most of them are
        // settled. Alphabetical order buries the two rows worth a person's
        // attention; `STATUS_ORDER` puts description drift first.
        mockReads({
            manifests: [
                manifest({ toolName: 'aaa_approved', status: 'APPROVED' }),
                manifest({ toolName: 'mmm_schema', status: 'SCHEMA_CHANGED',
                    liveSchemaHash: SCHEMA_LIVE, liveManifestHash: MANIFEST_LIVE }),
                { ...drifted, toolName: 'zzz_description' },
            ],
        });
        renderTab(true);

        const names = within(pinsSection())
            .getAllByText(/^(aaa_approved|mmm_schema|zzz_description)$/)
            .map((el) => el.textContent);
        expect(names).toEqual(['zzz_description', 'mmm_schema', 'aaa_approved']);
    });

    it('does NOT claim the description moved when only the composite digest did', () => {
        // `verifyToolManifest` reports DEFINITION_CHANGED for a composite-digest
        // move with both component digests unchanged — deliberately, to fail
        // loud. Rendering `explain.DEFINITION_CHANGED` there would tell the
        // operator the instruction text was rewritten, which is the one claim
        // on this screen anybody escalates on, and here it is false.
        mockReads({
            manifests: [
                manifest({
                    toolName: 'list_risks',
                    status: 'DEFINITION_CHANGED',
                    approvedDescriptionHash: DESC_APPROVED,
                    liveDescriptionHash: DESC_APPROVED,
                    approvedSchemaHash: SCHEMA_APPROVED,
                    liveSchemaHash: SCHEMA_APPROVED,
                    approvedManifestHash: MANIFEST_APPROVED,
                    liveManifestHash: MANIFEST_LIVE,
                }),
            ],
        });
        renderTab(true);

        const pins = pinsSection();
        // Positive companion: the row rendered, and it is still flagged.
        expect(within(pins).getByText('list_risks')).toBeInTheDocument();
        expect(within(pins).getByText(PINS.status.DEFINITION_CHANGED)).toBeInTheDocument();

        expect(within(pins).getByText(PINS.explainDefinitionOpaque)).toBeInTheDocument();
        expect(within(pins).queryByText(PINS.explain.DEFINITION_CHANGED)).not.toBeInTheDocument();
        // Both halves said to be unchanged, because both are.
        expect(within(pins).getByText(PINS.descriptionUnchanged)).toBeInTheDocument();
        expect(within(pins).getByText(PINS.schemaUnchanged)).toBeInTheDocument();
    });

    it('DOES claim it when both halves actually moved', () => {
        // The companion to the test above: `explain.DEFINITION_CHANGED` is a
        // sentence this component can reach, so its absence up there is a
        // decision rather than dead copy.
        mockReads({
            manifests: [
                manifest({
                    toolName: 'list_risks',
                    status: 'DEFINITION_CHANGED',
                    approvedDescriptionHash: DESC_APPROVED,
                    liveDescriptionHash: DESC_LIVE,
                    approvedSchemaHash: SCHEMA_APPROVED,
                    liveSchemaHash: SCHEMA_LIVE,
                    approvedManifestHash: MANIFEST_APPROVED,
                    liveManifestHash: MANIFEST_LIVE,
                }),
            ],
        });
        renderTab(true);

        const pins = pinsSection();
        expect(within(pins).getByText(PINS.explain.DEFINITION_CHANGED)).toBeInTheDocument();
        expect(within(pins).queryByText(PINS.explainDefinitionOpaque)).not.toBeInTheDocument();
        for (const label of [
            PINS.descriptionApproved,
            PINS.descriptionLive,
            PINS.schemaApproved,
            PINS.schemaLive,
        ]) {
            expect(within(pins).getByText(label)).toBeInTheDocument();
        }
    });

    it('the drift sentence names the instruction text in every locale it ships', () => {
        // The whole point of the pin. A copy edit that reduced this to "the
        // definition changed" would leave the ASI04 surface saying nothing a
        // reader could act on, in a place no other screen covers.
        expect(PINS.explain.DESCRIPTION_CHANGED).toMatch(/instruction text/i);
        expect(BG_PINS.explain.DESCRIPTION_CHANGED).toMatch(/инструкции/);
    });
});

describe('the grants list is exactly what the payload says', () => {
    it('offers a revoke control for the granted tools and for nothing else', () => {
        mockReads({
            granted: [grant('list_risks'), grant('list_controls')],
            available: ['list_risks', 'list_controls', 'draft_policy'],
            manifests: [manifest()],
        });
        renderTab(true);

        expect(screen.getByTestId('agent-tool-revoke-list_risks')).toBeInTheDocument();
        expect(screen.getByTestId('agent-tool-revoke-list_controls')).toBeInTheDocument();
        // In the build and grantable, but not granted — no row, so nothing to
        // revoke. Revoke is not idempotent, and a control for a grant that does
        // not exist is a guaranteed 404.
        expect(screen.queryByTestId('agent-tool-row-draft_policy')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-tool-revoke-draft_policy')).not.toBeInTheDocument();
        expect(screen.getByText('2 of 3 granted')).toBeInTheDocument();
    });

    it('drops the control as soon as the re-read drops the grant', () => {
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        const first = renderTab(true);
        expect(screen.getByTestId('agent-tool-revoke-list_risks')).toBeInTheDocument();
        first.unmount();

        mockReads({ granted: [], manifests: [manifest()] });
        renderTab(true);
        // Positive companion: the panel is alive and rendering its empty state,
        // so this absence is not a blank render.
        expect(screen.getByText(EN.noTools)).toBeInTheDocument();
        expect(screen.queryByTestId('agent-tool-revoke-list_risks')).not.toBeInTheDocument();
    });

    it('reads a second revoke as already-gone, not as a failed write', async () => {
        // `DELETE ?tool=` 404s on the second click. The row is gone, which is
        // what was asked for — a red banner there teaches operators to distrust
        // the emergency direction.
        installFetch(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'gone' } } }));
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        renderTab(true);

        fireEvent.click(screen.getByTestId('agent-tool-revoke-list_risks'));

        await waitFor(() => {
            expect(mockToast.info).toHaveBeenCalledWith('list_risks was already revoked');
        });
        // It re-reads, because the list it was acting on was stale.
        expect(grantsMutate).toHaveBeenCalled();
        expect(screen.queryByText(EN.revokeFailed)).not.toBeInTheDocument();
        expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('still reports a real failure loudly', async () => {
        // The companion: "no error banner" above is a decision about 404s, not
        // a panel that cannot report a failed revoke at all.
        installFetch(() => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }));
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        renderTab(true);

        fireEvent.click(screen.getByTestId('agent-tool-revoke-list_risks'));

        await waitFor(() => {
            expect(screen.getByText('boom')).toBeInTheDocument();
        });
        expect(mockToast.info).not.toHaveBeenCalled();
    });

    it('sends the tool in the query string, where a revoke can be formed from a URL', async () => {
        installFetch(() => ({ status: 200, body: {} }));
        mockReads({ granted: [grant('list_risks')], manifests: [manifest()] });
        renderTab(true);

        fireEvent.click(screen.getByTestId('agent-tool-revoke-list_risks'));

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalled();
        });
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/agents/agent-1/tools?tool=list_risks');
        expect(init.method).toBe('DELETE');
    });
});

describe('an agent with no grants', () => {
    it('renders the empty state rather than a permission problem', () => {
        mockReads({ granted: [], manifests: [manifest()] });
        renderTab(true);

        const grants = grantsSection();
        expect(within(grants).getByText(EN.noTools)).toBeInTheDocument();
        expect(within(grants).getByText(EN.noToolsDescription)).toBeInTheDocument();
        // An empty list is not a missing key. Saying so would send an operator
        // to ask for a permission they already hold.
        expect(within(grants).queryByText(EN.forbiddenTitle)).not.toBeInTheDocument();
        expect(within(grants).queryByText(EN.loadFailedTitle)).not.toBeInTheDocument();
        // The picker is still there — an empty list is the state you fix here.
        expect(screen.getByTestId('agent-tool-grant-submit')).toBeInTheDocument();
    });

    it('does not tell the reader the agent can do nothing', () => {
        // It cannot CALL A TOOL. That is not the same sentence: `/api/mcp` has
        // a second door, `resources/read` on audience `mcp:resources`, whose
        // token is minted from the register rather than from this list — so an
        // agent with zero grants still reads tenant grounding context. The
        // qualifier "tool call" is the whole difference and is what this pins.
        expect(EN.noToolsDescription).toMatch(/tool call/i);
        // Spelled out rather than looped over an array of regexes. A `toMatch`
        // whose argument is a loop variable is invisible to the assertion-span
        // ratchet, which counts un-analysable arguments precisely because a
        // variable the analyser cannot follow is the cheapest place for an
        // over-reaching span to hide — growth there is a finding, not a number
        // to re-baseline. Four assertions also name the offending phrase in the
        // failure output, which one loop never does.
        expect(EN.noToolsDescription).not.toMatch(/can do nothing/i);
        expect(EN.noToolsDescription).not.toMatch(/cannot do anything/i);
        expect(EN.noToolsDescription).not.toMatch(/no access/i);
        expect(EN.noToolsDescription).not.toMatch(/every call this agent/i);
        expect(EN.noTools).not.toMatch(/no access/i);
    });
});
