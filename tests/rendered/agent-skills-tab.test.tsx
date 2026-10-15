/**
 * #3470 — WHAT THIS AGENT CAN BE TAUGHT, and the claim this panel refuses.
 *
 * The acceptance criterion is "the Skills tab renders read-only and is
 * i18n-complete in en + bg", and the second half of that is easy to satisfy
 * badly: a panel can render every key and still make a claim the data does not
 * support. So the load-bearing assertions here are about what the panel says
 * rather than whether it renders.
 *
 * ── THE CLAIM AND THE REFUSAL ───────────────────────────────────────────────
 *
 * It lists the CORPUS — every skill the product ships — not "the skills this
 * agent used". An agent does not declare skills; a workflow definition does,
 * and a run loads what its definition asked for. A per-agent subset would mean
 * inventing a binding that does not exist, and on a compliance surface an
 * invented binding is worse than a broader true statement.
 *
 * Which makes the scope NOTICE load-bearing rather than decoration: without it
 * a reader on an agent's page reasonably assumes the list is that agent's. It
 * is asserted here for that reason, and the per-row "declared by" is asserted
 * in both directions — a skill nothing declares is shipped and unused, and
 * "we ship expertise nothing loads" is itself worth seeing.
 *
 * ── READ-ONLY IS AN ASSERTION, NOT A DESCRIPTION ────────────────────────────
 *
 * A skill is a reviewed Markdown document in the repository; changing one is a
 * pull request, not a form. So the panel must offer no control that implies
 * otherwise — asserted by counting the interactive elements, because "there is
 * no edit button" is the kind of claim a docblock makes and a later commit
 * quietly falsifies.
 *
 * ── WHAT THIS HARNESS CANNOT SEE ────────────────────────────────────────────
 *
 * The `next-intl` mock is this repo's standard one for rendered tests and does
 * `{param}` substitution only — no ICU plurals. The assertions are therefore
 * about the PRESENCE of a segment and the substituted values, never about a
 * formatted number.
 */
import { render, screen, cleanup, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    /**
     * A DOTTED path, walked the same way for the namespace and for the key.
     *
     * `SkillsTab` calls `useTranslations('agents.skills')`, so the namespace is
     * itself two segments — unlike the sibling agent-tab tests, whose panels
     * take a single-segment namespace and whose mocks index `en[ns]` directly.
     * One walker for both halves is why this file does not need a second
     * lookup rule for the nested case.
     */
    const walk = (root: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const dict = walk(en, ns);
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = walk(dict, key);
            // The KEY, returned unresolved — so a message this panel asks for
            // and the catalogue does not have shows up in the DOM as the key
            // rather than as plausible English.
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

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

import { SkillsTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab';

/**
 * The catalogue strings this file asserts on, read the way the component reads
 * them — so a reworded message fails HERE rather than silently matching
 * nothing. A literal copy would go stale the first time somebody edits the
 * copy, and the test would keep passing against text nobody renders.
 */
const EN = jest.requireActual('../../messages/en.json') as {
    agents: { skills: Record<string, unknown> };
};
const copy = (path: string): string => {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.agents.skills,
    );
    if (typeof v !== 'string') throw new Error(`messages/en.json has no agents.skills.${path}`);
    return v;
};

afterEach(cleanup);
beforeEach(() => jest.clearAllMocks());

function skill(over: Record<string, unknown> = {}) {
    return {
        name: 'iso-27001-annex-a-drafting',
        description: 'Draft an Annex A control narrative.',
        license: 'CC-BY-4.0',
        sourceRef: 'ISO/IEC 27001:2022',
        version: '1',
        declaredBy: ['audit-prep'],
        instructionBytes: 4096,
        ...over,
    };
}

function renderTab(state: Record<string, unknown>) {
    swr.mockReturnValue({ mutate: jest.fn(), ...state });
    return render(<SkillsTab tenantSlug="acme" agentId="agent-1" refreshToken={0} />);
}

describe('the panel reads the corpus endpoint', () => {
    it('asks for the skills route, not an agent-scoped one', () => {
        // THE ROUTE IS THE CLAIM. An `/admin/agents/{id}/skills` key would
        // promise a per-agent binding that does not exist; this panel is
        // honest precisely because it reads the corpus.
        renderTab({ data: { skills: [skill()], catalogBytes: 900, catalogBudgetBytes: 4000 } });
        expect(swr).toHaveBeenCalledWith('/admin/agents/skills');
    });
});

describe('every fetch state is named', () => {
    it('renders a skeleton while loading rather than an empty panel', () => {
        const { container } = renderTab({ isLoading: true, data: undefined });
        expect(container.querySelector('[data-testid="agent-skills-agent-1"]')).toBeNull();
        expect(screen.queryByText(copy('empty.title'))).toBeNull();
    });

    it('a failed read says so and offers a retry', () => {
        renderTab({ error: new Error('boom'), data: undefined });
        expect(screen.getByText(copy('loadFailed'))).toBeInTheDocument();
    });

    it('an EMPTY corpus is its own statement, not a blank panel', () => {
        // "The product ships no skill documents" is a true and useful thing to
        // say. Rendering nothing would be indistinguishable from a panel that
        // failed to read.
        renderTab({ data: { skills: [], catalogBytes: 0, catalogBudgetBytes: 4000 } });
        expect(screen.getByText(copy('empty.title'))).toBeInTheDocument();
    });
});

describe('the scope notice, which is what keeps the panel honest', () => {
    it('says the list is the corpus and not this agent’s history', () => {
        // Load-bearing. A reader on an agent's page reasonably assumes a list
        // there describes that agent; this sentence is the only thing between
        // them and that assumption.
        renderTab({ data: { skills: [skill()], catalogBytes: 900, catalogBudgetBytes: 4000 } });
        expect(screen.getByText(copy('scope.title'))).toBeInTheDocument();
        expect(screen.getByText(copy('scope.description'))).toBeInTheDocument();
    });

    it('reports the per-turn catalogue cost beside its budget', () => {
        // Invisible everywhere else, and it is what bounds how many skills a
        // workflow may mount: every mounted skill's name and description sit in
        // every system prompt on every turn.
        renderTab({ data: { skills: [skill()], catalogBytes: 912, catalogBudgetBytes: 4000 } });
        expect(screen.getByText(/912 of 4000 bytes/)).toBeInTheDocument();
    });
});

describe('each row says whether anything actually loads it', () => {
    it('names the declaring workflows', () => {
        renderTab({
            data: {
                skills: [skill({ declaredBy: ['audit-prep', 'posture-review'] })],
                catalogBytes: 900,
                catalogBudgetBytes: 4000,
            },
        });
        expect(screen.getByText(/audit-prep, posture-review/)).toBeInTheDocument();
    });

    it('says so when NOTHING declares it, rather than leaving the badge blank', () => {
        // A shipped-and-unused skill is worth seeing: it costs nothing per turn
        // and it means the corpus and the workflows have drifted apart.
        renderTab({
            data: { skills: [skill({ declaredBy: [] })], catalogBytes: 900, catalogBudgetBytes: 4000 },
        });
        expect(screen.getByText(copy('declaredByNone'))).toBeInTheDocument();
    });

    it('shows the LICENCE, which is why the corpus can be audited at all', () => {
        // Every skill must declare one — `flue-skills-corpus` refuses a corpus
        // where one does not — and this is the surface an assessor reads it on.
        renderTab({ data: { skills: [skill()], catalogBytes: 900, catalogBudgetBytes: 4000 } });
        expect(screen.getByText(copy('field.licence'))).toBeInTheDocument();
        expect(screen.getByText('CC-BY-4.0')).toBeInTheDocument();
        expect(screen.getByText('ISO/IEC 27001:2022')).toBeInTheDocument();
    });

    it('omits source and version when the skill declares neither', () => {
        // Rendered conditionally rather than as an empty row: a blank `Source`
        // beside a licence reads as a missing attribution rather than as a
        // skill that is this product's own work.
        renderTab({
            data: {
                skills: [skill({ sourceRef: null, version: null })],
                catalogBytes: 900,
                catalogBudgetBytes: 4000,
            },
        });
        expect(screen.queryByText(copy('field.source'))).toBeNull();
        expect(screen.queryByText(copy('field.version'))).toBeNull();
        // The two unconditional fields are still there, so this is an omission
        // rather than a panel that failed to render its detail list.
        expect(screen.getByText(copy('field.licence'))).toBeInTheDocument();
        expect(screen.getByText(copy('field.onActivation'))).toBeInTheDocument();
    });

    it('separates the ON-ACTIVATION cost from the per-turn one', () => {
        // The two numbers answer different questions and a panel that showed
        // one would mislead about the other: instructions cost nothing until
        // the model activates the skill, and the catalogue line above costs on
        // every turn regardless.
        renderTab({
            data: {
                skills: [skill({ instructionBytes: 4096 })],
                catalogBytes: 912,
                catalogBudgetBytes: 4000,
            },
        });
        expect(screen.getByText('4096 bytes')).toBeInTheDocument();
        expect(screen.getByText(/912 of 4000 bytes/)).toBeInTheDocument();
    });
});

describe('read-only is asserted, not described', () => {
    it('offers no control that implies a skill can be edited here', () => {
        // A skill is a reviewed Markdown document in the repository; changing
        // one is a pull request. Counted rather than eyeballed, because "there
        // is no edit button" is exactly the claim a later commit falsifies
        // quietly.
        const { container } = renderTab({
            data: {
                skills: [skill(), skill({ name: 'soa-authoring', declaredBy: [] })],
                catalogBytes: 1800,
                catalogBudgetBytes: 4000,
            },
        });
        const panel = within(container).getByTestId('agent-skills-agent-1');
        expect(panel.querySelectorAll('button, input, select, textarea, [role="button"]'))
            .toHaveLength(0);
        // Both rows rendered, so the count above is over a populated panel
        // rather than an empty one.
        expect(screen.getByText('iso-27001-annex-a-drafting')).toBeInTheDocument();
        expect(screen.getByText('soa-authoring')).toBeInTheDocument();
    });
});
