/**
 * ASK THE WORKSPACE A QUESTION (#3869, M2 of the SAP agent integration roadmap).
 *
 * A person types a question; a registered agent answers it from this
 * workspace's own records. M1 (#3868, ADR 0004) settled the authority half —
 * a session is its own principal, so the answer can never reach data the asker
 * could not reach through the UI — and this is the workflow that session runs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS DEFINITION HAS NO READ STEPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other Flue workflow here names its reads up front, because every other
 * one knows its question in advance: `posture-review` always wants the posture
 * and the expiring evidence, `sap-transaction-review` always wants controls and
 * risks. An AD-HOC question does not know, and that is the whole point of it.
 *
 * So the step list is ONE synthesis and no fixed reads. The tool surface still
 * exists — it comes from the AGENT'S GRANTS, not from the steps, resolved by
 * `flueToolsFor(…, { readOnly })` — and the model picks from it. Naming a fixed
 * read here would spend a tool call and a slice of the context window on
 * something most questions do not want, and it would quietly teach the model
 * that the named read is the one that matters.
 *
 * That the catalogue comes from grants rather than steps is also why
 * `EMPTY_CATALOGUE` is reachable at all for this workflow: an agent holding no
 * tool grants has nothing to answer from, and a run that proceeds anyway
 * produces prose with no records behind it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `readOnly: true` IS LOAD-BEARING, NOT DECORATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Flue workflow with no PROPOSE step is NOT read-only by default: the model
 * picks its own calls from everything its agent is granted, propose tools
 * included. `readOnly: true` is what withholds the propose surface, each
 * withheld tool recorded as a `READ_ONLY_WORKFLOW` omission.
 *
 * It matters more here than anywhere else in the registry. The other read-only
 * workflows are started by a job or an operator against a fixed subject; this
 * one is started by a PERSON TYPING, so the text that reaches the model is the
 * most attacker-shaped input in the product. Without this flag, a question
 * could ask for a proposal and get one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIBERATELY NOT ADVERTISED ON THE A2A CARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no `a2aSkill` member, and its absence is the decision rather than an
 * omission. #3862 publishes a skill per advertised workflow to external hosts;
 * advertising THIS one would hand an outside caller a general-purpose question
 * endpoint over the workspace's records, which is a disclosure nobody has
 * decided. `sap-transaction-review` is advertisable precisely because its
 * inputs are facts the CALLER supplies and its scope is fixed. "Ask us
 * anything" is not that, and if it is ever wanted it is an owner decision with
 * its own threat-model row, not a member added to this object.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SANITISATION AND THE CAP LIVE IN THE USECASE, NOT HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A client component imports the workflow registry, so every definition is in
 * the browser bundle and may not reach a server-only module or a Node built-in
 * — `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * walks the import graph and holds it. The guardrail over this directory also
 * requires definition files to be pure data with no usecase imports.
 *
 * So the cap LIVES here as a plain number, because the definition and the
 * usecase must agree on one value, and the ENFORCEMENT lives in the usecase
 * where `sanitizePlainText` can be reached. A cap declared in two places
 * eventually disagrees, and the half that is wrong is whichever one nobody
 * tested.
 */
import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';
import { requiredString } from './required-input';

/**
 * The longest question accepted, in characters.
 *
 * Bounded because the question is untrusted text that becomes part of a model
 * prompt: an unbounded one is a context-exhaustion lever and a cost lever at
 * the same time. 2000 characters is several paragraphs — far more than a
 * question needs and far less than a pasted document, which is the shape this
 * is meant to refuse.
 *
 * Enforced in the usecase (see the header). Declared here so there is ONE
 * value, and so the refusal and the definition cannot drift apart.
 */
export const AD_HOC_QUESTION_MAX_CHARS = 2_000;

export const adHocQuestionWorkflow: WorkflowDefinition = {
    driver: 'flue',
    readOnly: true,
    /**
     * Refused at ADMISSION when absent or blank, rather than failing inside the
     * synthesis. The declaration and the read below are held equal by
     * `canned-workflows-coverage`: a key declared and never read would refuse
     * runs for an input nothing consumes.
     */
    requiredInput: ['question'],

    key: 'ad-hoc-question',
    name: 'Ad-hoc question',
    description:
        'Answer the question in the run input from this workspace records, reading only what the asking ' +
        'person could read themselves. Cite what was read. Where the records do not answer the question, ' +
        'say so plainly rather than inferring — an answer with nothing behind it is worse than no answer. ' +
        'Read-only: propose nothing, change nothing.',
    steps: [
        {
            kind: 'SYNTHESIS',
            label: 'answer',
            synthesize: (ctx: WorkflowContext) => {
                /**
                 * READ, not re-narrated — and read for two separate reasons.
                 *
                 * The guardrail reason: `canned-workflows-coverage` pairs
                 * `requiredInput` against the keys this source actually reads,
                 * so declaring `question` and not reading it would make the
                 * admission refusal protect nothing.
                 *
                 * The substantive reason: on Flue the question reaches the
                 * model through `run-message.ts`, which delivers declared input
                 * as fenced, labelled `agent.run-input` data. That is the
                 * driver doing its job, not this definition — and it is why the
                 * question is put in `data` below rather than pasted into the
                 * answer prose. Re-emitting third-party text inside our own
                 * narrative is how untrusted input gets read as our report.
                 */
                const question = requiredString(ctx, 'question');

                /**
                 * THIS ARM IS THE STATIC ENGINE'S, AND IT CANNOT ANSWER.
                 *
                 * `driver: 'flue'` is a REQUEST. On a deployment where Flue is
                 * not permitted the selector resolves to the static engine,
                 * which walks steps and calls no model — so there is no
                 * answer to give, only the honest statement that none was
                 * produced.
                 *
                 * Said plainly on purpose. The failure mode worth avoiding is
                 * an answer-SHAPED string: a reader who gets "no issues found"
                 * from a run that consulted nothing has been actively misled,
                 * which is the same defect as a compliance check that passes
                 * over an empty population.
                 */
                return {
                    text:
                        'No answer was produced: this run used the static engine, which calls no model. ' +
                        'An ad-hoc question is answered on the Flue engine, so enable it for this ' +
                        'workspace and ask again. The question itself was accepted and is recorded below.',
                    data: {
                        question,
                        answered: false,
                        reason: 'STATIC_ENGINE_CANNOT_ANSWER',
                    },
                };
            },
        },
    ],
};
