/**
 * Rendered test for the agent RISK ASSESSMENT tab.
 *
 * Every block below defends a sentence the panel could otherwise say that
 * would be FALSE, and each one is a claim about a control an assessor will
 * later ask about.
 *
 * ## The completion does not file evidence
 *
 * `POST .../complete` scores the run and returns `evidence.emitted: false` —
 * a descriptor is BUILT and nothing is FILED. An operator who reads the
 * success notice as "the artefact is recorded" stops looking for the artefact
 * that does not exist, so the notice has to deny it in words. The denial is
 * read off the RESPONSE rather than hardcoded, which is the other half of the
 * claim: on the day the seam is wired the panel must stop denying, and it must
 * also stay silent when the server said nothing at all — "we were not told" is
 * not "we were told no", and only the second licenses a claim about the
 * artefact.
 *
 * ## `staleness === null` is NOT APPLICABLE, not "fresh"
 *
 * A `null` verdict means the run recorded no basis, so the drift comparison
 * never ran. Rendering that as the success-toned "Still matches the agent"
 * asserts a comparison nobody made — the reason both the unknown and the fresh
 * branch are rendered here, so the absence of the fresh copy in the null case
 * cannot pass because the string went missing.
 *
 * ## The completeness gate is client-side only
 *
 * The route has NO completeness precondition: it will score a never-touched
 * agent, count every unanswered applicable question as NO, and write a real
 * tier onto the agent that then caps every tool call. The confirmation dialog
 * is the only thing standing in front of that, so the tests assert it NAMES
 * the count rather than warning vaguely, and that the button is enabled — the
 * gate is a sentence a human must read, not a disabled control, and a test
 * that assumed otherwise would be pinning a protection that is not there.
 *
 * ## A completed run is never reopened
 *
 * `openAssessment` is load-or-create and never reopens a COMPLETED run, so
 * re-scoring mints a successor DRAFT. Unlabelled, "Standing assessment: HIGH,
 * completed today" above twenty blanks reads as "my answers were lost", and
 * the recovery that reading invites opens a third run.
 *
 * ## Stale triggers are named
 *
 * A bare "stale" tells an operator nothing about what moved; the trigger codes
 * translate to names. And the two triggers a re-score cannot answer
 * (TOOL_GRANTED, MODEL_CHANGED) get the opposite body text to the four axis
 * triggers — "the cap already tightened" is false on that path, and believing
 * it defers a re-answer against a control that is not in force.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` that builds derived state, which turns
// a render into a loop rather than a failure.
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

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () =>
        (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
}));

// The toast is not under test and sonner's module-scoped queue would outlive
// the render; the panel's claims are all made in the DOM.
jest.mock('sonner', () => ({
    toast: {
        success: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        dismiss: jest.fn(),
    },
}));

import { RiskAssessmentTab } from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/RiskAssessmentTab';

// ─── The real strings the operator reads ────────────────────────────────

const EN = (
    require('../../messages/en.json') as {
        admin: {
            agentDetail: {
                risk: Record<string, string> & {
                    trigger: Record<string, string>;
                    runStatus: Record<string, string>;
                };
            };
        };
    }
).admin.agentDetail.risk;

/** The same `{param}` substitution the component's `t` performs. */
const fill = (msg: string, params: Record<string, string | number>) => {
    let out = msg;
    for (const [k, v] of Object.entries(params))
        out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    return out;
};

/**
 * The literal tail of an ICU plural message — the part after the `{count,
 * plural, …}` block. The catalogue's `unansweredCountAsNo` is a plural
 * message, and next-intl formats the plural block at runtime; the tail is
 * identical either way, so asserting on it reads the same sentence the
 * operator sees without pinning how the number was rendered.
 */
const icuTail = (msg: string) => msg.slice(msg.lastIndexOf('}}') + 2);

const bodyText = () => document.body.textContent ?? '';

// ─── Fixtures ───────────────────────────────────────────────────────────

type AnswerValue = 'NA' | 'NO' | 'PARTIALLY' | 'YES';

interface Question {
    id: string;
    domainId: number;
    text: string;
    guidance: string | null;
    criticality: string;
    mappings: unknown;
    answer: AnswerValue | null;
    note: string | null;
}

interface Standing {
    assessmentId: string;
    tier: string | null;
    tierInForce: string | null;
    score: number | null;
    completedAt: string | null;
    staleAt: string | null;
    staleTriggers: string[];
    staleness: { stale: boolean; triggers: string[]; detail: string[] } | null;
}

interface State {
    agent: { id: string; name: string; riskTier: string | null; riskTierScoredAt: string | null };
    assessmentId: string;
    status: string;
    questionSetVersion: number;
    domains: { id: number; code: string; name: string; description: string }[];
    questions: Question[];
    standing: Standing | null;
}

const DOMAINS = [
    {
        id: 1,
        code: 'AUTONOMY',
        name: 'Autonomy and oversight',
        description: 'How far the agent may act without a human in the loop.',
    },
    {
        id: 2,
        code: 'DATA',
        name: 'Data scope',
        description: 'What the agent may read and what it may write.',
    },
];

/** Five questions, three in the first dimension and two in the second. */
function questions(answers: (AnswerValue | null)[]): Question[] {
    return answers.map((answer, i) => ({
        id: `q${i + 1}`,
        domainId: i < 3 ? 1 : 2,
        text: `Question number ${i + 1}`,
        guidance: null,
        criticality: i === 0 ? 'CRITICAL' : 'MEDIUM',
        mappings: { asi: [`ASI-${i + 1}`], imda: [] },
        answer,
        note: null,
    }));
}

const NONE: (AnswerValue | null)[] = [null, null, null, null, null];

function makeStanding(over: Partial<Standing> = {}): Standing {
    return {
        assessmentId: 'run-completed',
        tier: 'HIGH',
        tierInForce: 'HIGH',
        score: 41,
        completedAt: '2026-08-01T09:00:00.000Z',
        staleAt: null,
        staleTriggers: [],
        staleness: { stale: false, triggers: [], detail: [] },
        ...over,
    };
}

function makeState(over: Partial<State> = {}): State {
    return {
        agent: {
            id: 'agent-1',
            name: 'Reconciler',
            riskTier: 'HIGH',
            riskTierScoredAt: '2026-08-01T09:00:00.000Z',
        },
        assessmentId: 'run-open',
        status: 'DRAFT',
        questionSetVersion: 3,
        domains: DOMAINS,
        questions: questions(NONE),
        standing: null,
        ...over,
    };
}

/**
 * One stable object per test — `mutate` must keep its identity across
 * re-renders or the `refreshToken` bridge effect re-fires forever.
 */
function mockPage(state: State) {
    mockSWR.mockReturnValue({
        data: state,
        error: undefined,
        isLoading: false,
        mutate: jest.fn(),
    });
}

function renderTab(canManageRegistry = true) {
    return render(
        <RiskAssessmentTab
            tenantSlug="acme"
            agentId="agent-1"
            canManageRegistry={canManageRegistry}
        />,
    );
}

const completeButton = () =>
    document.querySelector('#agent-risk-complete-btn') as HTMLButtonElement | null;
const confirmButton = () =>
    document.querySelector('#agent-risk-complete-confirm') as HTMLButtonElement | null;

interface ScoreResponse {
    tier: string;
    score: number;
    band: string;
    floors: string[];
    breakdown: { applicableQuestions: number; unansweredQuestions: number };
    evidence?: { emitted: boolean };
}

/** Open the dialog and confirm, resolving the POST with `scored`. */
async function scoreIt(scored: ScoreResponse) {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => scored });
    fireEvent.click(completeButton() as HTMLButtonElement);
    fireEvent.click(confirmButton() as HTMLButtonElement);
    await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
});

// ────────────────────────────────────────────────────────────────────────

describe('the completion notice — what was scored, and what was NOT filed', () => {
    const scored: ScoreResponse = {
        tier: 'HIGH',
        score: 47,
        band: 'MODERATE',
        floors: ['autonomy floor'],
        breakdown: { applicableQuestions: 5, unansweredQuestions: 5 },
        evidence: { emitted: false },
    };

    it('says plainly that no evidence artefact was filed, and claims nothing else about one', async () => {
        mockPage(makeState());
        renderTab();
        await scoreIt(scored);

        // The positive companion: the notice demonstrably rendered, so the
        // absence assertion below is about copy rather than about a blank page.
        await waitFor(() => {
            expect(
                screen.getByText(fill(EN.scoredTitle, { tier: 'HIGH', score: 47 })),
            ).toBeInTheDocument();
        });
        expect(
            screen.getByText(
                fill(EN.scoredFloors, { band: 'MODERATE', floors: 'autonomy floor' }),
            ),
        ).toBeInTheDocument();

        expect(screen.getByText(EN.scoredNoEvidence)).toBeInTheDocument();

        // And nowhere on the panel is there a SECOND sentence about evidence.
        // A descriptor was built and nothing was filed; one denial is the whole
        // truth the page is entitled to tell.
        const outside = bodyText().split(EN.scoredNoEvidence).join(' ');
        expect(outside).not.toMatch(/evidence/i);
    });

    it('stays silent about evidence when the server did not answer the question', async () => {
        mockPage(makeState());
        renderTab();
        await scoreIt({ ...scored, evidence: undefined });

        await waitFor(() => {
            expect(
                screen.getByText(fill(EN.scoredTitle, { tier: 'HIGH', score: 47 })),
            ).toBeInTheDocument();
        });
        // `=== false`, not falsy: an absent field is "we were not told", which
        // licenses no claim about the artefact in either direction.
        expect(screen.queryByText(EN.scoredNoEvidence)).not.toBeInTheDocument();
        expect(bodyText()).not.toMatch(/evidence/i);
    });

    it('stops denying the artefact the moment the server reports one WAS filed', async () => {
        mockPage(makeState());
        renderTab();
        await scoreIt({ ...scored, evidence: { emitted: true } });

        await waitFor(() => {
            expect(
                screen.getByText(fill(EN.scoredTitle, { tier: 'HIGH', score: 47 })),
            ).toBeInTheDocument();
        });
        // The sentence is read off the response, so wiring the emission seam
        // silences it rather than leaving a false denial on screen.
        expect(screen.queryByText(EN.scoredNoEvidence)).not.toBeInTheDocument();
    });

    it('phrases the sentence as a denial, not as a filing receipt', () => {
        // The copy IS the claim here, so it is pinned in the catalogue too: a
        // rewrite to "Evidence artefact recorded for this run" would keep every
        // DOM assertion above green while inverting what the panel says.
        expect(EN.scoredNoEvidence).toMatch(/^No evidence artefact was filed/);
    });
});

describe('the standing tier — a null verdict is not freshness', () => {
    it('reports that freshness could not be determined, and never that the run is fresh', () => {
        mockPage(
            makeState({
                standing: makeStanding({ staleness: null, staleTriggers: [] }),
            }),
        );
        renderTab();

        // Positive companion: the standing block rendered with its facts.
        expect(screen.getByText(EN.standingHeading)).toBeInTheDocument();
        expect(screen.getByText(EN.factScoredTier)).toBeInTheDocument();
        expect(screen.getByText('41')).toBeInTheDocument();

        expect(screen.getByText(EN.stalenessUnknownTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.stalenessUnknownBody)).toBeInTheDocument();

        // `null` means the comparison never ran. The success-toned copy would
        // assert a comparison nobody made.
        expect(screen.queryByText(EN.freshTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(EN.freshBody)).not.toBeInTheDocument();
        expect(screen.queryByText(EN.staleTitle)).not.toBeInTheDocument();
    });

    it('does render the fresh copy when the comparison actually ran and found nothing', () => {
        mockPage(makeState({ standing: makeStanding() }));
        renderTab();

        // The pair is what makes the previous test non-vacuous: the fresh
        // strings are reachable, so their absence above is a real branch and
        // not a missing key.
        expect(screen.getByText(EN.freshTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.freshBody)).toBeInTheDocument();
        expect(screen.queryByText(EN.stalenessUnknownTitle)).not.toBeInTheDocument();
    });

    it('says the agent has never been assessed rather than showing an empty tier', () => {
        mockPage(makeState({ standing: null }));
        renderTab();

        expect(screen.getByText(EN.neverScoredTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.neverScoredBody)).toBeInTheDocument();
        expect(screen.queryByText(EN.freshTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(EN.stalenessUnknownTitle)).not.toBeInTheDocument();
    });
});

describe('a stale run names what moved', () => {
    it('lists the triggers by name instead of a bare "stale"', () => {
        mockPage(
            makeState({
                standing: makeStanding({
                    staleTriggers: ['AUTONOMY_RAISED', 'DATA_SCOPE_WIDENED'],
                    staleness: {
                        stale: true,
                        triggers: ['AUTONOMY_RAISED', 'DATA_SCOPE_WIDENED'],
                        detail: ['autonomyLevel 3 → 5'],
                    },
                }),
            }),
        );
        renderTab();

        expect(screen.getByText(EN.staleTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.trigger.AUTONOMY_RAISED)).toBeInTheDocument();
        expect(screen.getByText(EN.trigger.DATA_SCOPE_WIDENED)).toBeInTheDocument();
        // The comparison's own words, verbatim — the panel cannot drift from
        // what the verdict actually said.
        expect(screen.getByText('autonomyLevel 3 → 5')).toBeInTheDocument();

        // The raw codes are the storage vocabulary, not the operator's.
        expect(screen.queryByText('AUTONOMY_RAISED')).not.toBeInTheDocument();
        expect(screen.queryByText('DATA_SCOPE_WIDENED')).not.toBeInTheDocument();
    });

    it('says the tier WAS recomputed when an axis the scorer reads moved', () => {
        mockPage(
            makeState({
                standing: makeStanding({
                    staleTriggers: ['AUTONOMY_RAISED'],
                    staleness: { stale: true, triggers: ['AUTONOMY_RAISED'], detail: [] },
                }),
            }),
        );
        renderTab();

        expect(screen.getByText(EN.staleBody)).toBeInTheDocument();
        expect(screen.queryByText(EN.staleNoRescoreBody)).not.toBeInTheDocument();
        // The tool-cap consolation belongs only to the path where nothing
        // re-ran; here the re-score IS the answer.
        expect(screen.queryByText(EN.staleToolCapNote)).not.toBeInTheDocument();
    });

    it('says the tier was NOT recomputed when only a tool grant made it stale', () => {
        mockPage(
            makeState({
                standing: makeStanding({
                    staleTriggers: ['TOOL_GRANTED'],
                    staleness: { stale: true, triggers: ['TOOL_GRANTED'], detail: [] },
                }),
            }),
        );
        renderTab();

        // `rescoreAgainstStandingAnswers` short-circuits on the four scorer
        // axes, and the tool count is not one of them: nothing re-ran and the
        // cap has not tightened. The other body claims the opposite, and an
        // operator who believed it would defer a re-answer against a control
        // that is not in force.
        expect(screen.getByText(EN.staleNoRescoreBody)).toBeInTheDocument();
        expect(screen.queryByText(EN.staleBody)).not.toBeInTheDocument();
        expect(screen.getByText(EN.trigger.TOOL_GRANTED)).toBeInTheDocument();
        expect(screen.getByText(EN.staleToolCapNote)).toBeInTheDocument();
    });

    it('renders an unrecognised trigger code verbatim rather than a translation key', () => {
        // `staleTriggers` is a String column, not a Postgres enum, so a code
        // this build has never heard of is reachable.
        mockPage(
            makeState({
                standing: makeStanding({
                    staleTriggers: ['MEMORY_ENABLED'],
                    staleness: { stale: true, triggers: ['MEMORY_ENABLED'], detail: [] },
                }),
            }),
        );
        renderTab();

        expect(screen.getByText('MEMORY_ENABLED')).toBeInTheDocument();
        expect(screen.queryByText('agentDetail.risk.trigger.MEMORY_ENABLED')).not.toBeInTheDocument();
    });
});

describe('completing scores a never-touched run — the warning is all that stands there', () => {
    it('names the unanswered count on the panel and again in the dialog', () => {
        mockPage(makeState({ questions: questions(NONE) }));
        renderTab();

        expect(screen.getByText(fill(EN.completeness, { answered: 0, total: 5 }))).toBeInTheDocument();
        // The plural block is formatted by next-intl at runtime; the tail is
        // the same sentence either way, and it is the half that says what
        // completing now would DO.
        expect(bodyText()).toContain(icuTail(EN.unansweredCountAsNo));

        fireEvent.click(completeButton() as HTMLButtonElement);

        // The dialog names the number the SERVER is about to count — every
        // applicable question, scored as No.
        expect(
            screen.getByText(fill(EN.confirmUnanswered, { count: 5, applicable: 5 })),
        ).toBeInTheDocument();
    });

    it('does not pretend the route refuses an incomplete run — the gate is the dialog', () => {
        mockPage(makeState({ questions: questions(NONE) }));
        renderTab();

        const open = completeButton();
        expect(open).not.toBeNull();
        // `POST .../complete` carries no completeness precondition: it will
        // score this run and write a real tier. A disabled button here would
        // be a comfortable lie about a protection that does not exist.
        expect(open).not.toBeDisabled();
        expect(screen.getByText(EN.completeHint)).toBeInTheDocument();

        fireEvent.click(open as HTMLButtonElement);
        expect(confirmButton()).not.toBeDisabled();
        // Opening the dialog scores nothing — the only client-side gate is the
        // sentence the operator has to read first.
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('names the smaller count once some questions are answered', () => {
        // q1 YES, q2 N/A (leaves the denominator), q3-q5 untouched.
        mockPage(makeState({ questions: questions(['YES', 'NA', null, null, null]) }));
        renderTab();

        expect(screen.getByText(fill(EN.completeness, { answered: 2, total: 5 }))).toBeInTheDocument();
        fireEvent.click(completeButton() as HTMLButtonElement);
        expect(
            screen.getByText(fill(EN.confirmUnanswered, { count: 3, applicable: 4 })),
        ).toBeInTheDocument();
    });

    it('warns that an all-N/A run is the worst answer set, not a complete one', () => {
        mockPage(makeState({ questions: questions(['NA', 'NA', 'NA', 'NA', 'NA']) }));
        renderTab();

        // 5 of 5 recorded — the bar is full and the run is at its worst.
        expect(screen.getByText(fill(EN.completeness, { answered: 5, total: 5 }))).toBeInTheDocument();
        expect(screen.getAllByText(EN.allNotApplicable).length).toBeGreaterThan(0);
        expect(bodyText()).not.toContain(icuTail(EN.unansweredCountAsNo));

        fireEvent.click(completeButton() as HTMLButtonElement);
        expect(screen.getAllByText(EN.allNotApplicable).length).toBe(2);
    });

    it('drops the unanswered warning only when every applicable question is answered', () => {
        mockPage(makeState({ questions: questions(['YES', 'NO', 'PARTIALLY', 'NA', 'YES']) }));
        renderTab();

        expect(bodyText()).not.toContain(icuTail(EN.unansweredCountAsNo));
        fireEvent.click(completeButton() as HTMLButtonElement);

        // Positive companion: the dialog is open and still states the
        // irreversibility, so the two absences are about the warnings.
        expect(screen.getByText(EN.confirmTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.confirmNeverReopened)).toBeInTheDocument();
        expect(
            screen.queryByText(fill(EN.confirmUnanswered, { count: 0, applicable: 4 })),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(EN.allNotApplicable)).not.toBeInTheDocument();
    });
});

describe('a completed run is never reopened', () => {
    it('states it in the dialog and offers no reopen control anywhere', () => {
        mockPage(makeState({ questions: questions(['YES', 'YES', 'YES', 'YES', 'YES']) }));
        renderTab();

        // Scanned off the DOM rather than the accessibility tree: an open
        // Radix dialog marks the page behind it `aria-hidden`, so a
        // `getAllByRole('button')` sweep after the click would see the two
        // dialog buttons and call that "anywhere".
        const buttons = () => Array.from(document.querySelectorAll('button'));
        // Positive companion — the panel's controls demonstrably rendered.
        expect(buttons().length).toBeGreaterThan(20);
        expect(completeButton()).toBeInTheDocument();
        for (const button of buttons())
            expect(button.textContent ?? '').not.toMatch(/reopen/i);

        fireEvent.click(completeButton() as HTMLButtonElement);

        expect(screen.getByText(EN.confirmNeverReopened)).toBeInTheDocument();
        expect(screen.getByText(EN.confirmPrompt)).toBeInTheDocument();
        expect(confirmButton()).toBeInTheDocument();
        // The dialog is the last place a "reopen instead" affordance could
        // plausibly be offered, and it is not offered there either.
        for (const button of buttons())
            expect(button.textContent ?? '').not.toMatch(/reopen/i);
    });

    it('labels the successor draft so blank questions do not read as lost answers', () => {
        mockPage(
            makeState({
                assessmentId: 'run-open',
                questions: questions(NONE),
                standing: makeStanding({ assessmentId: 'run-completed' }),
            }),
        );
        renderTab();

        // The standing block and the blank questionnaire are two DIFFERENT
        // runs on one screen; unlabelled, the blanks read as data loss.
        expect(screen.getByText(EN.newRunTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.newRunBody)).toBeInTheDocument();
        expect(screen.getByText(EN.standingHeading)).toBeInTheDocument();
    });

    it('drops the successor-draft notice once this run has answers of its own', () => {
        mockPage(
            makeState({
                assessmentId: 'run-open',
                questions: questions(['YES', null, null, null, null]),
                standing: makeStanding({ assessmentId: 'run-completed' }),
            }),
        );
        renderTab();

        // Positive companion: the questionnaire rendered and knows this run is
        // partially recorded.
        expect(screen.getByText(fill(EN.completeness, { answered: 1, total: 5 }))).toBeInTheDocument();
        expect(screen.queryByText(EN.newRunTitle)).not.toBeInTheDocument();
    });

    it('names the open run status separately from the standing one', () => {
        mockPage(
            makeState({ status: 'IN_PROGRESS', standing: makeStanding({ assessmentId: 'run-completed' }) }),
        );
        renderTab();

        // Two assessments are on this page. The badge is what stops the
        // questionnaire borrowing the standing block's authority.
        expect(screen.getByText(EN.runStatus.IN_PROGRESS)).toBeInTheDocument();
        expect(screen.getByText(fill(EN.questionSetVersion, { version: 3 }))).toBeInTheDocument();
    });
});
