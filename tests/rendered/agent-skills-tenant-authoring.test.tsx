/**
 * #3680 — THE SKILLS TAB GAINS AUTHORING, AND THE REPOSITORY CORPUS STAYS
 * READ-ONLY.
 *
 * The tab has two sections. The repository section lists the skills the product
 * ships and must offer no control whoever is looking — asserted by counting
 * interactive elements inside it while the viewer CAN author, which is the case
 * that would tempt a later commit to reuse a control there. The workspace
 * section lists this tenant's own skills and offers authoring and review only
 * to a holder of `admin.agent_skill_review`.
 *
 * Three further claims are held here because the surface is where they would
 * quietly break:
 *
 *   • a refused workspace skill is shown by rule id, never by its text;
 *   • the author of a version in review is not offered Approve (the server
 *     refuses it anyway; the panel says why instead of rendering a button that
 *     403s);
 *   • Approve sends back the content hash on screen, so the approval is of the
 *     text the reviewer read.
 */
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const walk = (root: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = walk(walk(en, ns), key);
        if (typeof v !== 'string') return key;
        if (params)
            for (const [p, val] of Object.entries(params))
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The confirm dialogs mount a Modal, which reads the app router.
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));
const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ error: toastError, success: toastSuccess }),
}));

import { SkillsTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab';

const EN = jest.requireActual('../../messages/en.json') as { agents: { skills: Record<string, unknown> } };
const copy = (path: string): string => {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.agents.skills,
    );
    if (typeof v !== 'string') throw new Error(`messages/en.json has no agents.skills.${path}`);
    return v;
};

const CONTROLS = 'button, input, select, textarea, [role="button"]';
const HASH = `sha256:${'a'.repeat(64)}`;

function repoSkill(over: Record<string, unknown> = {}) {
    return {
        name: 'iso-27001-annex-a-drafting',
        description: 'Draft an Annex A control narrative.',
        license: 'proprietary',
        sourceRef: 'original guidance',
        version: '1',
        declaredBy: ['audit-prep'],
        instructionBytes: 4096,
        ...over,
    };
}

function tenantSkill(over: Record<string, unknown> = {}) {
    return {
        id: 'skill-1',
        name: 'pwc-joiner-review',
        inService: {
            versionId: 'ver-1',
            version: 1,
            license: 'PwC proprietary',
            sourceRef: 'PwC IAM methodology',
            description: 'Check a joiner request against the access policy.',
            workflowKeys: ['discovered-agent-review'],
            instructionBytes: 512,
            mount: { ok: true },
        },
        open: null,
        refused: null,
        ...over,
    };
}

function version(over: Record<string, unknown> = {}) {
    return {
        id: 'ver-2',
        version: 2,
        status: 'IN_REVIEW',
        retiredReason: null,
        contentHash: HASH,
        workflowKeys: ['discovered-agent-review'],
        license: 'PwC proprietary',
        sourceRef: 'PwC IAM methodology',
        requiredInput: null,
        output: null,
        controls: null,
        tools: null,
        description: 'Check a joiner request against the access policy.',
        instructions: 'Review one joiner request against the access policy.',
        textRefused: null,
        author: { userId: 'u-other', label: 'Avery Author', isViewer: false },
        evaluation: {
            attachedAt: '2026-10-18T10:00:00.000Z',
            attachedBy: { userId: 'u-other', label: 'Avery Author' },
            check: {
                rates: { task: 1, refusal: 1, injection: 1, 'missing-input': 1 },
                model: { provider: 'anthropic', revision: 'claude-sonnet-5-5' },
                ranAt: '2026-10-18T09:00:00.000Z',
                caseCount: 4,
            },
        },
        approvedBy: null,
        canApprove: true,
        mount: null,
        ...over,
    };
}

function payload(over: Record<string, unknown> = {}) {
    return {
        skills: [repoSkill()],
        refused: [],
        tenantSkills: [tenantSkill()],
        attachableWorkflows: [{ key: 'discovered-agent-review', name: 'Discovered agent review' }],
        catalogBytes: 900,
        catalogBudgetBytes: 2048,
        ...over,
    };
}

function serve(listing: Record<string, unknown>, detail?: Record<string, unknown>) {
    swr.mockImplementation((key: string | null) => {
        if (key === '/admin/agents/skills') return { data: listing, error: undefined, isLoading: false, mutate: jest.fn() };
        if (key && key.startsWith('/admin/agents/skills/tenant/') && detail) {
            return { data: detail, error: undefined, isLoading: false, mutate: jest.fn(async () => undefined) };
        }
        return { data: undefined, error: undefined, isLoading: true, mutate: jest.fn() };
    });
}

// One flag stood for both halves until #3778; a holder of both is what most
// cases here exercise, so `canAuthorSkills` follows `canReviewSkills` unless a
// case splits them.
const renderTab = (canReviewSkills: boolean, canAuthorSkills: boolean = canReviewSkills) =>
    render(
        <SkillsTab
            tenantSlug="acme"
            agentId="agent-1"
            refreshToken={0}
            canReviewSkills={canReviewSkills}
            canAuthorSkills={canAuthorSkills}
        />,
    );

afterEach(cleanup);
beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'APPROVED' }) })) as unknown as typeof fetch;
});

describe('repository skills remain read-only in the product', () => {
    it('renders no control in the repository section, even for a viewer who can author workspace skills', () => {
        serve(payload());
        renderTab(true);
        const repository = screen.getByTestId('agent-skills-repository');
        expect(within(repository).getByText('iso-27001-annex-a-drafting')).toBeInTheDocument();
        expect(repository.querySelectorAll(CONTROLS)).toHaveLength(0);
        // The count above is over a section next to one that DOES have
        // controls, so it is not passing on a panel that renders none at all.
        const tenant = screen.getByTestId('agent-skills-tenant');
        expect(within(tenant).getByTestId('tenant-skill-new')).toBeInTheDocument();
        expect(within(tenant).getByTestId('tenant-skill-review-pwc-joiner-review')).toBeInTheDocument();
    });
});

describe('the workspace section', () => {
    it('lists the workspace skills read-only for a viewer without the review right', () => {
        serve(payload());
        const { container } = renderTab(false);
        const tenant = screen.getByTestId('agent-skills-tenant');
        expect(within(tenant).getByText('pwc-joiner-review')).toBeInTheDocument();
        expect(within(tenant).getByText('PwC proprietary')).toBeInTheDocument();
        expect(within(tenant).getByText(copy('tenant.inService').replace('{version}', '1'))).toBeInTheDocument();
        expect(within(container).getByTestId('agent-skills-agent-1').querySelectorAll(CONTROLS)).toHaveLength(0);
    });

    it('shows a refused workspace skill by rule id, never by its text', () => {
        serve(payload({
            tenantSkills: [
                tenantSkill({
                    inService: { ...tenantSkill().inService, description: null, mount: { ok: false, reason: 'TEXT_REFUSED' } },
                    refused: { rules: ['skill.reveal_context'], guardRules: ['inj.instruction_override.reveal_prompt'] },
                }),
            ],
        }));
        renderTab(true);
        const refused = screen.getByTestId('tenant-skill-pwc-joiner-review-refused');
        expect(refused.textContent).toContain('skill.reveal_context, inj.instruction_override.reveal_prompt');
        expect(screen.queryByText('Check a joiner request against the access policy.')).toBeNull();
    });

    it('says so when the workspace has authored nothing, and still offers authoring to a holder', () => {
        serve(payload({ tenantSkills: [] }));
        renderTab(true);
        expect(screen.getByTestId('agent-skills-tenant-empty')).toHaveTextContent(copy('tenant.empty'));
        expect(screen.getByTestId('tenant-skill-new')).toBeInTheDocument();
    });
});

describe('review', () => {
    it('does not offer Approve to the version’s author, and says why', async () => {
        serve(payload(), {
            id: 'skill-1',
            name: 'pwc-joiner-review',
            versions: [version({ author: { userId: 'u-me', label: 'Me', isViewer: true }, canApprove: false })],
        });
        renderTab(true);
        fireEvent.click(screen.getByTestId('tenant-skill-review-pwc-joiner-review'));
        await waitFor(() => expect(screen.getByTestId('tenant-skill-version-2')).toBeInTheDocument());
        expect(screen.queryByTestId('tenant-skill-approve-2')).toBeNull();
        expect(screen.getByTestId('tenant-skill-author-note-2')).toHaveTextContent(copy('sheet.authorCannotApprove'));
        // The text under review is on screen, as text.
        expect(screen.getByTestId('tenant-skill-version-2-instructions')).toHaveTextContent('Review one joiner request');
    });

    it('approves with the content hash on screen', async () => {
        serve(payload(), { id: 'skill-1', name: 'pwc-joiner-review', versions: [version()] });
        renderTab(true);
        fireEvent.click(screen.getByTestId('tenant-skill-review-pwc-joiner-review'));
        await waitFor(() => expect(screen.getByTestId('tenant-skill-approve-2')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('tenant-skill-approve-2'));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/agents/skills/tenant/skill-1/versions/ver-2/approve');
        expect(JSON.parse(String(init.body))).toEqual({ contentHash: HASH });
    });

    it('withholds the text of a version the scan refuses, and offers it no approval', async () => {
        serve(payload(), {
            id: 'skill-1',
            name: 'pwc-joiner-review',
            versions: [
                version({
                    description: null,
                    instructions: null,
                    textRefused: { rules: ['skill.fetchable_url'], guardRules: [] },
                    evaluation: null,
                    status: 'DRAFT',
                    canApprove: false,
                }),
            ],
        });
        renderTab(true);
        fireEvent.click(screen.getByTestId('tenant-skill-review-pwc-joiner-review'));
        await waitFor(() => expect(screen.getByTestId('tenant-skill-version-2-refused')).toBeInTheDocument());
        expect(screen.getByTestId('tenant-skill-version-2-refused')).toHaveTextContent('skill.fetchable_url');
        expect(screen.queryByTestId('tenant-skill-version-2-instructions')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-attach-2')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-approve-2')).toBeNull();
    });
});

describe('the two halves (#3778): authoring and review are separate keys', () => {
    const draft = () =>
        version({ status: 'DRAFT', canApprove: false, author: { userId: 'u-me', label: 'Me', isViewer: true } });
    const inReview = () => version();

    it('an author who cannot review gets New skill and the authoring acts, and no review act', async () => {
        serve(payload(), { id: 'skill-1', name: 'pwc-joiner-review', versions: [draft(), { ...inReview(), id: 'ver-3', version: 3, canApprove: false }] });
        renderTab(false, true);
        expect(screen.getByTestId('tenant-skill-new')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('tenant-skill-review-pwc-joiner-review'));
        await waitFor(() => expect(screen.getByTestId('tenant-skill-version-2')).toBeInTheDocument());
        expect(screen.getByTestId('tenant-skill-edit')).toBeInTheDocument();
        expect(screen.getByTestId('tenant-skill-submit-2')).toBeInTheDocument();
        // Nothing the review key does: no approve (the server says canApprove
        // false without it), no reject, no retire.
        expect(screen.queryByTestId('tenant-skill-approve-3')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-reject-3')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-retire-2')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-retire-3')).toBeNull();
    });

    it('a reviewer who cannot author gets the review acts, and no New skill, edit, attach or submit', async () => {
        serve(payload(), { id: 'skill-1', name: 'pwc-joiner-review', versions: [inReview(), { ...draft(), id: 'ver-4', version: 4, evaluation: null }] });
        renderTab(true, false);
        expect(screen.queryByTestId('tenant-skill-new')).toBeNull();
        fireEvent.click(screen.getByTestId('tenant-skill-review-pwc-joiner-review'));
        await waitFor(() => expect(screen.getByTestId('tenant-skill-approve-2')).toBeInTheDocument());
        expect(screen.getByTestId('tenant-skill-reject-2')).toBeInTheDocument();
        expect(screen.getByTestId('tenant-skill-retire-2')).toBeInTheDocument();
        expect(screen.queryByTestId('tenant-skill-edit')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-attach-4')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-submit-4')).toBeNull();
    });

    it('a viewer with neither half opens no sheet and authors nothing', () => {
        serve(payload());
        renderTab(false, false);
        expect(screen.queryByTestId('tenant-skill-new')).toBeNull();
        expect(screen.queryByTestId('tenant-skill-review-pwc-joiner-review')).toBeNull();
    });
});
