/**
 * THE EVALUATIONS CARD SAYS WHAT THE WORKFLOWS DO, AND WHO SEES IT
 * (owner decision 2026-11-12).
 *
 *   1. Every fact the card shows is read back from its source: the workflow's
 *      cron, the repository variable its first step reads, the dedicated key
 *      secret, and the budget files. A moved schedule or a renamed variable
 *      fails here, not on the page.
 *   2. The card is shown to an org admin-tier viewer of every organization by
 *      default, except one the operator opts out in
 *      EVALS_CARD_HIDDEN_ORG_SLUGS; unset or empty hides it nowhere.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    EVAL_NIGHTLIES,
    EVAL_SHARED_KEY_SECRET,
    EVALS_ACTIONS_VARIABLES_URL,
    EVALS_REPOSITORY_URL,
    evalWorkflowRunsUrl,
    formatEvalUsd,
} from '@/lib/evals/evaluation-nightlies';
import { evalsCardVisible, parseEvalsCardOrgSlugs } from '@/lib/evals/evals-card-visibility';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('1. the typed content matches the workflows it describes', () => {
    it.each(EVAL_NIGHTLIES.map((n) => [n.key, n] as const))('%s', (_key, n) => {
        const wf = read(`.github/workflows/${n.workflowFile}`);
        const cron = /cron:\s*'(\d+) (\d+) \* \* \*'/.exec(wf);
        expect(cron).not.toBeNull();
        const [, minute, hour] = cron!;
        expect(n.scheduleUtc).toBe(`${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`);
        // The ONE repository variable the workflow reads is the card's switch.
        expect([...wf.matchAll(/\bvars\.([A-Z0-9_]+)/g)].map((m) => m[1])).toEqual([n.switchVariable]);
        // The key: every place the workflow picks one names the dedicated
        // secret first and the shared one otherwise.
        const keyPairs = new Set([...wf.matchAll(/secrets\.(\w+) \|\| secrets\.(\w+)/g)].map((m) => `${m[1]}|${m[2]}`));
        expect([...keyPairs]).toEqual([`${n.dedicatedKeySecret}|${EVAL_SHARED_KEY_SECRET}`]);
        // Off by default: a scheduled run needs the variable to be exactly 'true'.
        expect(/if \[ "\$EVENT" = "schedule" \] && \[ "\$ENABLED" != "true" \]/.test(wf)).toBe(true);
        // A manual dispatch always runs.
        expect(/^on:\n\s+workflow_dispatch:/m.test(wf)).toBe(true);
        expect(fs.existsSync(path.join(ROOT, n.roadmapDoc))).toBe(true);
    });

    it('garak spends its share of the shared nightly cap', () => {
        const garak = EVAL_NIGHTLIES.find((n) => n.key === 'garak')!;
        const shares = JSON.parse(read('evals/cost-meter/shares.json')) as {
            nightlyCapUsd: number;
            shares: Record<string, { usd: number }>;
        };
        expect(shares.shares.garak.usd).toBe(garak.budgetUsd);
        expect(shares.nightlyCapUsd).toBe(garak.sharedCapUsd);
        // The card says the cap is shared with Ragas.
        expect(Object.keys(shares.shares).sort()).toEqual(['garak', 'ragas']);
    });

    it('Inspect spends the nightly cap of its budget file', () => {
        const inspect = EVAL_NIGHTLIES.find((n) => n.key === 'inspect')!;
        const budget = JSON.parse(read('evals/inspect/budget.json')) as { nightlyCapUsd: number };
        expect(budget.nightlyCapUsd).toBe(inspect.budgetUsd);
        expect(inspect.sharedCapUsd).toBeNull();
    });

    it('derives every link from the one repository URL', () => {
        expect(EVALS_ACTIONS_VARIABLES_URL.startsWith(`${EVALS_REPOSITORY_URL}/`)).toBe(true);
        expect(evalWorkflowRunsUrl('garak.yml')).toBe(`${EVALS_REPOSITORY_URL}/actions/workflows/garak.yml`);
    });

    it('formats whole dollars whole and cents with two digits', () => {
        expect(formatEvalUsd(10)).toBe('10');
        expect(formatEvalUsd(2.5)).toBe('2.50');
    });
});

describe('2. who sees the card', () => {
    it('parses the operator list, ignoring blanks and whitespace', () => {
        expect([...parseEvalsCardOrgSlugs(' acme , ,beta,')]).toEqual(['acme', 'beta']);
        expect(parseEvalsCardOrgSlugs(undefined).size).toBe(0);
        expect(parseEvalsCardOrgSlugs('').size).toBe(0);
    });

    it('is shown to an owner or admin of an organization that has not opted out', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_ADMIN', hiddenIn: 'beta' })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: 'acme-group' })).toBe(true);
    });

    it('is shown everywhere when the opt-out list is unset or empty', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: undefined })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: '' })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: ' , ' })).toBe(true);
    });

    it('is hidden in an organization that opted out', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_ADMIN', hiddenIn: 'beta, acme' })).toBe(false);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: 'acme' })).toBe(false);
    });

    it('is hidden from a reader, whatever the list says', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_READER', hiddenIn: undefined })).toBe(false);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: null, hiddenIn: 'beta' })).toBe(false);
    });
});
