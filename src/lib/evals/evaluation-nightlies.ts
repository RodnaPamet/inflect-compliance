/**
 * The platform's three LLM evaluation nightlies, as static typed content for
 * the organization settings page's "Evaluations" card (owner decisions
 * 2026-11-12 and 2026-11-27).
 *
 * All three run as GitHub Actions against a throwaway copy of the app built on
 * the CI runner, never against production. Since 2026-11-27 each is switched
 * IN THE PRODUCT: the on/off state is a row of `EvalNightlySwitch`, set on the
 * card by an org owner of an operator organization, and a scheduled run asks
 * production for it over `GET /api/evals/nightly-switches` (with the CI secret
 * `EVALS_SWITCH_READ_TOKEN`), staying off on any answer but `true`. This module
 * holds the STATIC facts only — what each nightly tests, when it runs, what it
 * may spend, which key secret it uses — and the live state comes from the
 * usecase. `tests/unit/evaluation-nightlies.test.ts` holds every fact here to
 * the workflow file and budget file it is copied from, including that each
 * workflow's gate asks the switch endpoint for its own key, so a moved cron or
 * a renamed key fails CI instead of leaving the card wrong.
 *
 * Client-safe: no imports.
 */

/** The one place the repository's address is spelled. */
export const EVALS_REPOSITORY_URL = 'https://github.com/RodnaPamet/inflect-compliance';

/** A workflow's own runs page on GitHub. */
export function evalWorkflowRunsUrl(workflowFile: string): string {
    return `${EVALS_REPOSITORY_URL}/actions/workflows/${workflowFile}`;
}

/**
 * The switch keys, in the order the nightlies run. Each is also the key a
 * workflow's gate reads from the switch endpoint's JSON, and the value the
 * `EvalNightlySwitch_nightly_known` CHECK admits.
 */
export const EVAL_NIGHTLY_KEYS = ['ragas', 'garak', 'inspect'] as const;

export type EvalNightlyKey = (typeof EVAL_NIGHTLY_KEYS)[number];

export function isEvalNightlyKey(value: unknown): value is EvalNightlyKey {
    return typeof value === 'string' && (EVAL_NIGHTLY_KEYS as readonly string[]).includes(value);
}

/**
 * The shared key secret each nightly falls back to. These constants hold the
 * NAMES of GitHub Actions secrets, which the card displays; no value is ever
 * in this file, hence the secret-scan pragma on each line.
 */
export const EVAL_SHARED_KEY_SECRET = 'ANTHROPIC_API_KEY'; // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value

export interface EvalNightly {
    readonly key: EvalNightlyKey;
    /** Under `.github/workflows/`. */
    readonly workflowFile: string;
    /** The roadmap the workflow names as its source of intent. */
    readonly roadmapDoc: string;
    /** The scheduled time, UTC, `HH:MM`. */
    readonly scheduleUtc: string;
    /** The nightly spend cap this workflow is held to, in USD. */
    readonly budgetUsd: number;
    /** The cap that budget is a share of, when it is a share. */
    readonly sharedCapUsd: number | null;
    /** The owner decision that set the budget. */
    readonly budgetDecision: string;
    /** The dedicated key secret, used before the shared one. */
    readonly dedicatedKeySecret: string;
}

export const EVAL_NIGHTLIES: readonly EvalNightly[] = [
    {
        key: 'ragas',
        workflowFile: 'rag-eval.yml',
        roadmapDoc: 'docs/ai-architecture/ragas.md',
        scheduleUtc: '00:40',
        budgetUsd: 4,
        sharedCapUsd: 6.5,
        // The split of the shared cap, as the owner amended it on 2026-11-17.
        budgetDecision: 'D-EV-11',
        dedicatedKeySecret: 'RAGAS_ANTHROPIC_API_KEY', // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value
    },
    {
        key: 'garak',
        workflowFile: 'garak.yml',
        roadmapDoc: 'docs/ai-architecture/garak.md',
        scheduleUtc: '01:15',
        budgetUsd: 2.5,
        sharedCapUsd: 6.5,
        budgetDecision: 'D-EV-11',
        dedicatedKeySecret: 'GARAK_CI_ANTHROPIC_KEY', // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value
    },
    {
        key: 'inspect',
        workflowFile: 'agent-evals.yml',
        roadmapDoc: 'docs/ai-architecture/inspect.md',
        scheduleUtc: '02:20',
        budgetUsd: 10,
        sharedCapUsd: null,
        budgetDecision: 'D-EV-6',
        dedicatedKeySecret: 'INSPECT_CI_ANTHROPIC_KEY', // pragma: allowlist secret -- a GitHub secret's NAME shown on the card, never a value
    },
];

/** `2.5` → `2.50`, `10` → `10`: whole dollars stay whole. */
export function formatEvalUsd(amount: number): string {
    return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}
