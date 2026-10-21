/**
 * `sap-transaction-review` — the definition, its strict `facts` input, and the
 * honesty of what it reports (#3864).
 *
 * ## What this file can and cannot prove
 *
 * Two of the issue's named tests are about JUDGEMENT — "facts containing an SoD
 * conflict ⇒ the answer names the document and the control", and "clean facts ⇒
 * the answer says no conflict was found AND names what it was not given". Those
 * are answers a MODEL gives, so they are proved by the skill's evaluation set
 * (`creator-is-approver`, `clean-facts-names-what-was-not-given`,
 * `no-test-was-applicable`) against a real model revision, which is what the
 * mount gate requires before a run may mount the skill at all.
 *
 * What is deterministic — and therefore here — is everything the definition and
 * the schema decide without a model: which inputs are refused, which tools exist,
 * that no propose tool survives `readOnly`, and that the data the static engine
 * reports names what it was not given rather than implying it had everything.
 */
import { sapTransactionReviewWorkflow } from '@/lib/agentic/workflows/sap-transaction-review';
import {
    SAP_FACTS_LIMITS,
    readSapTransactionFacts,
    unjudgeableAspects,
} from '@/lib/agentic/workflows/sap-transaction-facts';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { isExternalToolName } from '@/lib/mcp/external-tool-name';
import { asA2aFactsJson, sapScenario, sapScenarios } from '../../fixtures/sap/sap-scenarios';
import type { WorkflowContext } from '@/lib/agentic/workflow-types';

const doc = (over: Record<string, unknown> = {}) => ({
    documentType: 'purchase order',
    documentNumber: '4500001234',
    createdBy: 'usr_1182',
    approvedBy: 'usr_900',
    amount: 48200,
    currency: 'EUR',
    documentDate: '2026-03-04',
    ...over,
});

const facts = (...docs: Array<Record<string, unknown>>) => JSON.stringify({ documents: docs });

describe('the definition', () => {
    it('is registered under its key', () => {
        expect(getWorkflowDefinition('sap-transaction-review')).toBe(sapTransactionReviewWorkflow);
    });

    it('requests Flue and declares its one skill', () => {
        expect(sapTransactionReviewWorkflow.driver).toBe('flue');
        expect(sapTransactionReviewWorkflow.skills).toEqual(['sap-transaction-review']);
    });

    it('requires both question and facts, so a run with neither is refused at admission', () => {
        expect(sapTransactionReviewWorkflow.requiredInput).toEqual(['question', 'facts']);
    });

    it('is read-only and has no PROPOSE step — the two together, not either alone', () => {
        // `readOnly` is what withholds propose tools on Flue, which does NOT
        // walk the steps; the absence of a PROPOSE step is what the static
        // engine honours. A definition with one and not the other is read-only
        // on one engine only.
        expect(sapTransactionReviewWorkflow.readOnly).toBe(true);
        expect(sapTransactionReviewWorkflow.steps.some((s) => s.kind === 'PROPOSE')).toBe(false);
    });

    it('reads only Inflect tools — nothing qualified to an external connection', () => {
        const tools = sapTransactionReviewWorkflow.steps
            .filter((s): s is typeof s & { tool: string } => 'tool' in s && typeof s.tool === 'string')
            .map((s) => s.tool);
        expect(tools.length).toBeGreaterThan(0);
        // Asserted through the REAL constant, not a guessed prefix: the prefix
        // is `mcp__`, and an earlier draft of this line checked `ext`, which no
        // tool name has ever started with — it would have passed for any input
        // at all. A step naming an external tool would mean the definition
        // itself reached outside the product, which is what #3860's policy
        // argument rests on not happening.
        for (const t of tools) expect(isExternalToolName(t)).toBe(false);
        expect(tools).toEqual(['list_controls', 'list_risks']);
    });

    it('is advertised on the host-consumer card, with no tool name in the copy', () => {
        const skill = sapTransactionReviewWorkflow.a2aSkill;
        expect(skill).toBeDefined();
        const text = JSON.stringify(skill);
        for (const t of ['list_controls', 'list_risks']) expect(text).not.toContain(t);
    });
});

describe('the facts schema is strict', () => {
    it('accepts a well-formed document', () => {
        const r = readSapTransactionFacts(facts(doc()));
        expect(r.ok).toBe(true);
    });

    it('REFUSES an unknown key, and names it', () => {
        const r = readSapTransactionFacts(facts(doc({ sapClient: '800' })));
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.reason).toBe('UNKNOWN_KEY');
        // Naming the key is the point: "unknown key" with no key is a refusal
        // the integrator cannot act on.
        expect(r.detail).toContain('sapClient');
    });

    it('refuses an unknown key nested in a line item too, not just at the top', () => {
        const r = readSapTransactionFacts(
            facts(doc({ lineItems: [{ description: 'widgets', amount: 100, taxCode: 'V1' }] })),
        );
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.reason).toBe('UNKNOWN_KEY');
        expect(r.detail).toContain('taxCode');
    });

    it('tells an INVALID_VALUE apart from an UNKNOWN_KEY', () => {
        // Different things to whoever is integrating — a newer schema versus a
        // bad payload — so one shared reason would make them indistinguishable.
        const r = readSapTransactionFacts(facts(doc({ currency: 'EUROS' })));
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.reason).toBe('INVALID_VALUE');
        expect(r.detail).toContain('currency');
    });

    it('refuses a non-JSON string as MALFORMED_JSON rather than throwing', () => {
        const r = readSapTransactionFacts('not json at all');
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.reason).toBe('MALFORMED_JSON');
    });

    it('refuses an empty document list — a review of nothing is not a review', () => {
        expect(readSapTransactionFacts(JSON.stringify({ documents: [] })).ok).toBe(false);
    });

    it('bounds the document count', () => {
        const many = Array.from({ length: SAP_FACTS_LIMITS.MAX_DOCUMENTS + 1 }, (_, i) =>
            doc({ documentNumber: `45000000${i}` }),
        );
        expect(readSapTransactionFacts(facts(...many)).ok).toBe(false);
    });

    it('keeps a date as the STRING it was sent as', () => {
        const r = readSapTransactionFacts(facts(doc({ documentDate: '2026-03-04' })));
        if (!r.ok) throw new Error('expected ok');
        // Not coerced to a Date: converting would apply this process's timezone
        // to someone else's calendar date, and the value judged would differ
        // from the value sent.
        expect(r.facts.documents[0].documentDate).toBe('2026-03-04');
        expect(typeof r.facts.documents[0].documentDate).toBe('string');
    });

    it('keeps a negative amount negative, so a credit is not hidden', () => {
        const r = readSapTransactionFacts(facts(doc({ amount: -500 })));
        if (!r.ok) throw new Error('expected ok');
        expect(r.facts.documents[0].amount).toBe(-500);
    });
});

describe('what it was NOT given is a value, not something the prose must remember', () => {
    it('names the missing approver, limit, line items and posting date', () => {
        const gaps = unjudgeableAspects(doc({ approvedBy: undefined }) as never);
        expect(gaps.join(' ')).toContain('no approver');
        expect(gaps.join(' ')).toContain('approval limit');
        expect(gaps.join(' ')).toContain('line items');
        expect(gaps.join(' ')).toContain('posting date');
    });

    it('names nothing when everything judgeable was supplied', () => {
        // The control that matters: a function that always reported gaps would
        // satisfy every assertion above and be useless.
        const gaps = unjudgeableAspects(
            doc({
                approvedBy: 'usr_900',
                approverLimit: 100000,
                postingDate: '2026-03-05',
                lineItems: [{ description: 'widgets', amount: 48200 }],
            }) as never,
        );
        expect(gaps).toEqual([]);
    });
});

describe('the static synthesis claims no judgement it did not make', () => {
    const ctx = (input: Record<string, unknown>, outputs: Record<string, unknown> = {}): WorkflowContext =>
        ({ input, outputs } as unknown as WorkflowContext);

    const synth = () => {
        const step = sapTransactionReviewWorkflow.steps.find((s) => s.kind === 'SYNTHESIS');
        if (!step || !('synthesize' in step)) throw new Error('no synthesis step');
        return step.synthesize;
    };

    it('reports the counts it read and says plainly that no judgement was made', () => {
        const out = synth()(ctx({ question: 'any SoD issues?', facts: facts(doc()) }, { controls: [{}, {}, {}] }));
        expect(out.data).toMatchObject({ factsAccepted: true, documents: 1, controlsAvailable: 3, judgementMade: false });
        expect(out.text).toContain('No judgement is made here');
    });

    it('carries the per-document gaps, so a reader cannot mistake it for a clearance', () => {
        const out = synth()(
            ctx({ question: 'q', facts: facts(doc({ approvedBy: undefined })) }, { controls: [] }),
        );
        const data = out.data as { notGiven: Array<{ documentNumber: string; notGiven: string[] }> };
        expect(data.notGiven[0].documentNumber).toBe('4500001234');
        expect(data.notGiven[0].notGiven.join(' ')).toContain('no approver');
    });

    it('reports an unreadable payload as unread rather than reviewing it', () => {
        const out = synth()(ctx({ question: 'q', facts: '{bad' }, { controls: [] }));
        expect(out.data).toMatchObject({ factsAccepted: false, reason: 'MALFORMED_JSON' });
        expect(out.text).toContain('No review was performed');
    });
});

describe('the shared SAP fixtures reach this workflow (#3867)', () => {
    // THE LINK THAT MAKES "ONE SOURCE" REAL. The scenarios in
    // `tests/fixtures/sap/sap-scenarios.ts` are the MCP route's fixture set,
    // and #3867 requires the same data to serve this workflow's tests rather
    // than a second copy of it.
    //
    // Scope, stated rather than implied: the local `doc()` above stays for
    // SCHEMA-SHAPE cases — an unknown key, a bound, a date kept as a string —
    // where a full scenario proves nothing extra. And the judgement cases live
    // in the evaluation set as PROSE, which cannot derive mechanically from
    // structured fixtures. What the shared file is the single source of is
    // structured facts, which is what these assert.

    it('the SoD scenario flows through the real schema and synthesis', () => {
        const facts = asA2aFactsJson(sapScenario('creator-is-approver'));
        const step = sapTransactionReviewWorkflow.steps.find((x) => x.kind === 'SYNTHESIS');
        if (!step || !('synthesize' in step)) throw new Error('no synthesis step');
        const out = step.synthesize({
            input: { question: 'any SoD issue?', facts },
            outputs: { controls: [{}, {}] },
        } as unknown as WorkflowContext);
        expect(out.data).toMatchObject({ factsAccepted: true, documents: 1, judgementMade: false });
    });

    it('a scenario with no approver reports the gap, through this workflow', () => {
        const facts = asA2aFactsJson(sapScenario('two-partners-one-name'));
        const step = sapTransactionReviewWorkflow.steps.find((x) => x.kind === 'SYNTHESIS');
        if (!step || !('synthesize' in step)) throw new Error('no synthesis step');
        const out = step.synthesize({
            input: { question: 'q', facts },
            outputs: { controls: [] },
        } as unknown as WorkflowContext);
        const data = out.data as { notGiven: Array<{ notGiven: string[] }> };
        expect(data.notGiven.some((g) => g.notGiven.join(' ').includes('no approver'))).toBe(true);
    });

    it('every scenario with documents is accepted by this workflow’s schema', () => {
        // Derived, not listed: a scenario added to the shared file that this
        // workflow cannot read fails HERE, which is the drift the single source
        // exists to prevent.
        const withDocs = sapScenarios().filter((s) => s.documents.length > 0);
        expect(withDocs.length).toBeGreaterThan(5);
        for (const scenario of withDocs) {
            const r = readSapTransactionFacts(asA2aFactsJson(scenario));
            expect({ id: scenario.id, ok: r.ok }).toEqual({ id: scenario.id, ok: true });
        }
    });
});
