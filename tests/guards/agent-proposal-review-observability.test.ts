/**
 * THE REVIEW QUEUE RECORDS DECISIONS, NOT ATTENTION — and the report says so.
 *
 * `computeReviewQuality` declares `DIFF_EXPANSION` unobservable: nothing in the
 * product knows whether a reviewer looked at a proposal's content before
 * approving it. That declaration is rendered to admins on
 * `/admin/agents/review-quality`, so it has to stay true. A stale "we cannot
 * tell you this" is worse than silence — it tells an operator not to look for
 * evidence that has since started existing.
 *
 * The three facts the declaration rests on are each asserted here, over the
 * live schema and the live source, so the declaration cannot outlive its own
 * reason:
 *
 *   1. `AgentProposal` has no column that could hold the answer.
 *   2. Nothing writes an audit action or an automation event naming a proposal
 *      being viewed, opened or expanded.
 *   3. The queue's own client renders the payload with no expand affordance, so
 *      there is no event to record even if something were listening.
 *
 * WHEN THIS GOES RED, THE FIX IS NOT TO LOOSEN IT. It means somebody added the
 * observation — good — and the same diff must drop `DIFF_EXPANSION` from
 * `UNOBSERVABLE_REVIEW_QUESTIONS`, teach the metrics engine to read it, and
 * delete the corresponding assertion here. The guard exists to make that a
 * package rather than three separate remembering-to-dos.
 *
 * This is deliberately NOT a check that a markdown file mentions the words. It
 * reads the schema, the source and the exported constant.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';
import {
    UNOBSERVABLE_REVIEW_QUESTIONS,
    computeReviewQuality,
} from '@/lib/agentic/automation-bias';

/** Column-name fragments that would mean "somebody looked at this row". */
const ATTENTION_COLUMN = /^(viewed|opened|seen|read|expanded|inspected)/i;

/**
 * An audit action or automation event naming attention on a proposal.
 *
 * Anchored on the two vocabularies the repo actually uses for these strings:
 * SHOUTY_SNAKE audit actions (`AGENT_PROPOSAL_APPROVED`) and dotted automation
 * event keys (`agent.proposal.approved`). A verb list rather than a free
 * substring, so the pattern cannot be satisfied by prose.
 */
const ATTENTION_EVENT =
    /(?:PROPOSAL_(?:VIEWED|OPENED|SEEN|READ|EXPANDED|INSPECTED))|(?:proposal\.(?:viewed|opened|seen|read|expanded|inspected))/;

describe('the declaration that diff expansion is unobservable rests on live facts', () => {
    it('is what the engine actually returns, not a comment about it', () => {
        // Imported, not grepped: the value the surface renders IS the subject.
        expect([...UNOBSERVABLE_REVIEW_QUESTIONS]).toEqual(['DIFF_EXPANSION']);
        expect(computeReviewQuality([]).unobservable).toEqual(['DIFF_EXPANSION']);
    });

    it('AgentProposal carries no column that could hold the answer', () => {
        const model = parseSchemaModels().find((m) => m.name === 'AgentProposal');
        // A missing model here would make every assertion below vacuous.
        expect(model).toBeDefined();
        const attention = (model?.scalarFieldNames ?? []).filter((f) => ATTENTION_COLUMN.test(f));
        expect(attention).toEqual([]);
        // The paired positive: the columns the report DOES stand on are present,
        // so a rename that emptied the model would fail here rather than pass
        // as "no attention columns found".
        expect(model?.scalarFieldNames).toEqual(
            expect.arrayContaining(['reviewedByUserId', 'reviewedAt', 'createdAt', 'status']),
        );
    });

    it('nothing in src/ records a proposal being viewed, opened or expanded', () => {
        const offenders = repoRelativeFiles()
            .filter((rel) => rel.startsWith('src/') && /\.tsx?$/.test(rel))
            .filter((rel) => {
                // Comments masked at the read seam: this guard's own prose, and
                // any doc comment discussing the gap, must not satisfy a check
                // about code.
                const code = codeOf(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
                return ATTENTION_EVENT.test(code);
            });
        expect(offenders).toEqual([]);
    });

    it('the queue renders the payload with nothing to expand', () => {
        // The third fact, and the one a UI change is most likely to move: an
        // expand affordance is the point at which an expansion event becomes
        // recordable at all. Asserted over the queue client's CODE.
        // BOUND to the component declaration, not the whole file. A whole-file
        // read here would let a `<details>` in a neighbouring helper satisfy —
        // or, on the negative assertions, be forbidden by — a claim about the
        // queue's own render. It is also the shape both assertion-reach
        // ratchets ask for.
        const client = codeOf(
            functionBodyOf(
                readFileSync(
                    path.join(
                        REPO_ROOT,
                        'src/app/t/[tenantSlug]/(app)/agent-proposals/AgentProposalsClient.tsx',
                    ),
                    'utf8',
                ),
                'AgentProposalsClient',
            ),
        );
        // The payload is rendered, unconditionally, in a plain `<pre>`.
        expect(client).toContain('JSON.stringify(payload, null, 2)');
        // …and there is no disclosure primitive around it. `<Accordion>` and
        // `<details>` are the two the repo would reach for.
        expect(client).not.toContain('<Accordion');
        expect(client).not.toContain('<details');
    });
});
