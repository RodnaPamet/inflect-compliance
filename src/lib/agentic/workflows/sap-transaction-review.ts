/**
 * SAP TRANSACTION REVIEW — the judgement a customer pays for (#3864; roadmap #3859).
 *
 * Joule hands over facts about SAP documents; Inflect's agent tests them against
 * the tenant's controls and says what it found. **It never calls SAP.** That is
 * not a promise made here — it is held by `a2a-host-consumer-policy.ts`, which
 * refuses any inbound host-consumer request whose receiving agent holds an
 * external tool grant at all. See the header there for why no flag gates it.
 *
 * ── WHAT IT IS GIVEN ────────────────────────────────────────────────────────
 *
 * `question` — what the host is asking, free text.
 * `facts`    — a JSON STRING, validated strictly by `sap-transaction-facts.ts`.
 *              A JSON string rather than an object because
 *              `assertRequiredInputPresent` refuses a `requiredInput` key that
 *              is not a non-empty string, and `a2a-inbound.ts` refuses a data
 *              key the definition does not declare. Both constraints together
 *              leave no route for a nested object.
 *
 * `run-message.ts` delivers both, fenced and labelled with their provenance,
 * followed by the data-only handling rule. Nothing here re-states that rule:
 * the whole input is scanned on the way in, and a sentence telling a model to
 * ignore directives reads to a pattern scanner like one.
 *
 * ── READ-ONLY, AND WHY THAT IS LOAD-BEARING HERE ────────────────────────────
 *
 * `readOnly: true`, so on Flue the run is offered the read surface alone and
 * every propose tool is withheld. A review is an ANSWER, not a change: raising
 * a Finding from one is a separate decision nobody has taken. Without this flag
 * a model choosing its own calls could propose, and "no PROPOSE step" would not
 * have prevented it — the static engine walks steps, Flue does not.
 *
 * ── THE TOOLS IT GETS, AND TWO THE ISSUE NAMED THAT DO NOT EXIST ────────────
 *
 * Inflect's own read tools only. The issue's list was "controls, policies,
 * risks, SoD rules, approval limits"; measured against `src/lib/mcp/tools`,
 * there is no SoD-rules tool and no approval-limits tool. Rather than invent
 * two tools inside this issue, the steps read what exists — `list_controls`
 * and `list_risks` — and the SoD reasoning comes from the SKILL, which is
 * where the issue put it anyway. An approval limit, when the host knows one,
 * arrives as a FACT (`approverLimit`); when it does not, the answer says the
 * limit question could not be tested rather than assuming a limit.
 *
 * ── ON THE STATIC ENGINE ────────────────────────────────────────────────────
 *
 * `driver: 'flue'` is a REQUEST; on a deployment without Flue it resolves to
 * static, which walks these steps literally. The synthesis below therefore says
 * only what the READ steps returned and states plainly that no judgement was
 * made — like `audit-narrative`'s. A synthesis that described an SoD conflict
 * from a document count would be inventing one.
 */
import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';
import { requiredString } from './required-input';
import { readSapTransactionFacts, unjudgeableAspects } from './sap-transaction-facts';

/** The one skill a run of this workflow is taught. */
export const SAP_TRANSACTION_REVIEW_SKILLS = ['sap-transaction-review'] as const;

export const sapTransactionReviewWorkflow: WorkflowDefinition = {
    driver: 'flue',
    skills: SAP_TRANSACTION_REVIEW_SKILLS,
    readOnly: true,
    /** Both refused at admission when absent or blank — see `requiredInput` on the type. */
    requiredInput: ['question', 'facts'],

    // Advertised on the host-consumer card (#3862). This is the workflow the A2A
    // route exists for, so it is the one a host most needs to discover. Safe to
    // publish: read-only, and its inputs are things the CALLER supplies rather
    // than internal ids it would have to be told.
    a2aSkill: {
        name: 'Review SAP transactions against controls',
        description:
            'Tests facts about SAP documents — who created and approved them, amounts, dates, line items ' +
            '— against this workspace controls, and reports what it found: the document, the control, and ' +
            'the reason. Judges only the facts supplied and states what it was not given, so a clean result ' +
            'is never presented as proof of compliance. Reads no SAP system and changes nothing.',
        tags: ['sap', 'erp', 'segregation-of-duties', 'controls', 'review'],
        examples: [
            'Did anyone approve a purchase order they raised themselves?',
            'Check these journal entries against our segregation-of-duties controls.',
        ],
    },

    key: 'sap-transaction-review',
    name: 'SAP transaction review',
    description:
        'Test the SAP documents described in the run input against this workspace controls and report what ' +
        'was found: for each issue, the document, the control it tests and why it is an issue. Judge only the ' +
        'facts supplied — no SAP system is read — and state plainly what was NOT supplied, because the absence ' +
        'of a conflict in the facts given is not evidence of compliance. Read-only: propose nothing, change nothing.',
    steps: [
        { kind: 'READ', label: 'controls', tool: 'list_controls', args: () => ({ limit: 100 }) },
        {
            kind: 'READ',
            label: 'risks',
            tool: 'list_risks',
            args: () => ({ limit: 50 }),
            // Enrichment. A tenant with no risk register should still get a
            // transaction review rather than a FAILED row; the failure is still
            // recorded and still counted.
            continueOnFailure: true,
        },
        {
            kind: 'SYNTHESIS',
            label: 'review',
            synthesize: (ctx: WorkflowContext) => {
                const reading = readSapTransactionFacts(requiredString(ctx, 'facts'));
                const controls = ctx.outputs['controls'];
                const controlCount = Array.isArray(controls) ? controls.length : 0;

                // THE QUESTION IS RECORDED, NOT RE-NARRATED.
                //
                // It goes in `data` rather than into the answer prose, for two
                // reasons. It is third-party text, and re-emitting it inside
                // the narrative would put untrusted prose where a later reader
                // meets it as part of our own report. And a structured field is
                // where an auditor looks for "what was this run asked"; a
                // sentence is not.
                //
                // It is READ here rather than merely declared because
                // `tests/guardrails/canned-workflows-coverage.test.ts` holds
                // the two directions equal: a key declared and never read
                // refuses runs for an input nothing consumes. On Flue the
                // question does reach the model through `run-message.ts`, but
                // that is the driver delivering declared input, not this
                // definition using it.
                const question = requiredString(ctx, 'question');

                // A payload that does not validate is reported as such rather
                // than judged. On Flue admission has already refused it; this
                // arm is the static engine's, and it must not pretend to a
                // review of something it could not read.
                if (!reading.ok) {
                    return {
                        text:
                            `The facts supplied could not be read (${reading.reason}: ${reading.detail}). ` +
                            'No review was performed.',
                        data: { question, factsAccepted: false, reason: reading.reason, detail: reading.detail },
                    };
                }

                const docs = reading.facts.documents;
                const gaps = docs.map((d) => ({ documentNumber: d.documentNumber, notGiven: unjudgeableAspects(d) }));
                const withGaps = gaps.filter((g) => g.notGiven.length > 0).length;

                return {
                    text:
                        `${docs.length} SAP document(s) supplied and read; ${controlCount} control(s) available to ` +
                        `test against. ${withGaps} document(s) carry facts that were NOT supplied, so some tests ` +
                        'could not be applied. No judgement is made here — the review is the answer given on the ' +
                        'Flue engine, which this run did not use.',
                    data: {
                        question,
                        factsAccepted: true,
                        documents: docs.length,
                        controlsAvailable: controlCount,
                        documentsWithUnjudgeableAspects: withGaps,
                        notGiven: gaps,
                        judgementMade: false,
                    },
                };
            },
        },
    ],
};
