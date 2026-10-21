/**
 * THE SHARED SAP FIXTURES, AND THAT BOTH SHAPES COME FROM THEM (#3867 step 2).
 *
 * The point of one source file is that the SAP-shaped view and the A2A-shaped
 * view of the same order cannot disagree. That is only true if the derivation
 * is exercised, so these tests run every scenario through `asA2aFacts` and hand
 * the result to the REAL validator — `readSapTransactionFacts`, the one J4's
 * workflow uses.
 *
 * Without that, "one source, two shapes" would be a claim in a docblock: the
 * fixtures could derive to something the schema refuses and nobody would know
 * until a test that used them was written.
 */
import {
    asA2aFacts,
    asA2aFactsJson,
    sapDates,
    sapScenario,
    sapScenarios,
} from '../../fixtures/sap/sap-scenarios';
import { readSapTransactionFacts, unjudgeableAspects } from '@/lib/agentic/workflows/sap-transaction-facts';

describe('the fixture set covers the roadmap’s list', () => {
    it('ships a scenario for every case the roadmap names', () => {
        // Asserted as an exact set: #3867 lists these, and a fixture quietly
        // dropped is a case nobody tests any more.
        expect(sapScenarios().map((s) => s.id).sort()).toEqual([
            'approval-above-limit',
            'billing-creator-on-item',
            'created-yesterday',
            'creator-is-approver',
            'creator-with-no-documents',
            'injection-in-free-text',
            'multi-currency',
            'two-creators-two-customers',
            'two-partners-one-name',
        ]);
    });

    it('every scenario says what it proves, in a sentence', () => {
        // A fixture whose purpose nobody recorded gets "simplified" by the next
        // reader. The multi-currency rows look redundant until you know why.
        for (const s of sapScenarios()) {
            expect(s.proves.length).toBeGreaterThan(40);
        }
    });

    it('names a missing scenario rather than returning undefined', () => {
        // A silent undefined would make a test that used it vacuous.
        expect(() => sapScenario('no-such-case')).toThrow(/No SAP scenario/);
    });
});

describe('the cases that only exist for a boundary', () => {
    it('dates are RELATIVE, so the yesterday case keeps testing yesterday', () => {
        // A fixture pinned to a literal date stops testing the boundary the
        // moment that date is in the past.
        const { today, yesterday } = sapDates('2026-03-04');
        expect(today).toBe('2026-03-04');
        expect(yesterday).toBe('2026-03-03');
        const far = sapDates('2027-01-01');
        expect(far.yesterday).toBe('2026-12-31');
        // And the scenario actually uses it.
        expect(sapScenario('created-yesterday', '2027-01-01').documents[0].documentDate).toBe('2026-12-31');
    });

    it('the two-by-two grid really is four distinct creator/customer pairs', () => {
        const s = sapScenario('two-creators-two-customers');
        const pairs = s.documents.map((d) => `${d.createdBy}/${d.soldToParty}`);
        expect(new Set(pairs).size).toBe(4);
    });

    it('the two partners share a name PREFIX but not a number', () => {
        const s = sapScenario('two-partners-one-name');
        const names = s.partners.map((p) => p.name);
        expect(names.every((n) => n.startsWith('Northwind Supplies'))).toBe(true);
        expect(new Set(s.partners.map((p) => p.soldToParty)).size).toBe(2);
    });

    it('the multi-currency case cannot be summed, and EUR is not the largest', () => {
        // The second half matters: if EUR happened to be the biggest, a naive
        // sum would still rank them correctly and the fixture would prove less.
        const s = sapScenario('multi-currency');
        expect(new Set(s.documents.map((d) => d.currency)).size).toBe(3);
        const eur = s.documents.find((d) => d.currency === 'EUR')!;
        expect(Math.max(...s.documents.map((d) => d.amount))).toBeGreaterThan(eur.amount);
    });

    it('the no-documents case really has none, so an empty result is a finding', () => {
        const s = sapScenario('creator-with-no-documents');
        expect(s.users).toHaveLength(1);
        expect(s.documents).toEqual([]);
    });

    it('the billing document puts the creator on the ITEM and the customer on the HEADER', () => {
        const s = sapScenario('billing-creator-on-item');
        const doc = s.documents[0];
        expect(doc.createdBy).toBeUndefined();
        expect(doc.soldToParty).toBeDefined();
        expect(doc.items?.every((i) => i.createdBy)).toBe(true);
    });

    it('the injection sits in a free-text field, where SAP legitimately puts prose', () => {
        const s = sapScenario('injection-in-free-text');
        expect(s.documents[0].note).toMatch(/ignore previous instructions/i);
    });
});

describe('the A2A derivation produces facts the REAL validator accepts', () => {
    // The assertion that makes "one source, two shapes" true rather than
    // claimed. Run against `readSapTransactionFacts`, which is what the
    // workflow itself uses.
    const withDocuments = sapScenarios().filter((s) => s.documents.length > 0);

    it('there are scenarios to derive, or the loop below proves nothing', () => {
        expect(withDocuments.length).toBeGreaterThan(5);
    });

    it.each(withDocuments.map((s) => [s.id, s] as const))('%s derives to valid facts', (_id, scenario) => {
        const reading = readSapTransactionFacts(asA2aFactsJson(scenario));
        if (!reading.ok) throw new Error(`${scenario.id}: ${reading.reason} — ${reading.detail}`);
        expect(reading.facts.documents).toHaveLength(scenario.documents.length);
    });

    it('translates the SAP username into the identifier the A2A side names people by', () => {
        const facts = asA2aFacts(sapScenario('creator-is-approver'));
        // Not the raw SAPUSER_* form: a finding quotes what the caller sent.
        expect(facts.documents[0].createdBy).toBe('usr_alice');
        expect(facts.documents[0].approvedBy).toBe('usr_alice');
    });

    it('translates soldToParty into the customer NAME a finding can quote', () => {
        const facts = asA2aFacts(sapScenario('two-creators-two-customers'));
        expect(facts.documents.map((d) => d.customer)).toContain('Northwind Supplies');
        // The number is not what a host sends or a finding quotes.
        expect(JSON.stringify(facts)).not.toContain('0000101001');
    });

    it('lifts a billing document’s per-item creator to the document', () => {
        const facts = asA2aFacts(sapScenario('billing-creator-on-item'));
        expect(facts.documents[0].createdBy).toBe('usr_boris');
        expect(facts.documents[0].lineItems).toHaveLength(2);
    });

    it('REFUSES to lift when items disagree about the creator', () => {
        // The lift is only valid while every item shares a creator. Asserted
        // rather than assumed, because a silent pick would attribute a document
        // to one of two people with no way to tell which.
        const base = sapScenario('billing-creator-on-item');
        const broken = {
            ...base,
            documents: [
                {
                    ...base.documents[0],
                    items: [
                        { description: 'a', amount: 1, createdBy: 'SAPUSER_ALICE' },
                        { description: 'b', amount: 2, createdBy: 'SAPUSER_BORIS' },
                    ],
                },
            ],
        };
        expect(() => asA2aFacts(broken)).toThrow(/no single createdBy/);
    });

    it('does NOT carry the free-text note, which the strict schema would refuse', () => {
        // The A2A schema has no field for it, and an unknown key is refused
        // rather than stripped — so carrying it would make this scenario
        // underivable. The injection case therefore tests the MCP side.
        const scenario = sapScenario('injection-in-free-text');
        expect(scenario.documents[0].note).toBeDefined();
        const facts = asA2aFacts(scenario);
        expect(JSON.stringify(facts)).not.toMatch(/ignore previous instructions/i);
        expect(readSapTransactionFacts(asA2aFactsJson(scenario)).ok).toBe(true);
    });
});

describe('the derived facts exercise J4’s judgement cases', () => {
    it('the SoD breach survives the translation', () => {
        // The reason this scenario lives in the shared file: the SAP-shaped and
        // A2A-shaped views of one breach must agree that it IS one.
        const sap = sapScenario('creator-is-approver').documents[0];
        expect(sap.createdBy).toBe(sap.approvedBy);
        const derived = asA2aFacts(sapScenario('creator-is-approver')).documents[0];
        expect(derived.createdBy).toBe(derived.approvedBy);
    });

    it('the limit breach keeps both numbers, so the test stays applicable', () => {
        const derived = asA2aFacts(sapScenario('approval-above-limit')).documents[0];
        expect(derived.approverLimit).toBe(10000);
        expect(derived.amount).toBeGreaterThan(derived.approverLimit!);
    });

    it('a document with no approver reports the gap J4 names', () => {
        // `two-partners-one-name`'s documents carry no approver, so they are
        // the natural fixture for "could not be tested".
        const derived = asA2aFacts(sapScenario('two-partners-one-name')).documents[0];
        expect(derived.approvedBy).toBeUndefined();
        expect(unjudgeableAspects(derived as never).join(' ')).toContain('no approver');
    });
});
