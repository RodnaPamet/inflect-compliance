/**
 * The deterministic engine, on data it was NOT authored against (#3516).
 *
 * `identity-reconcile-precision.test.ts` gates precision and floors recall, and
 * reads `CORPUS` for both — so the only set the engine was measured on was the
 * only set that existed. This runs the same gate over `HELD_OUT`, whose
 * expectations were written from the question a reviewer answers rather than
 * from the engine's output. See that fixture's header for why that distinction
 * is the whole point.
 *
 * ── WHAT IS GATED AND WHAT IS REPORTED ─────────────────────────────────────
 *
 * GATED: a false `LINKED`. An auto-link to somebody the case does not name is
 * the failure that reaches a customer — a row written as confirmed that nobody
 * confirmed — and it is gated here exactly as on the corpus.
 *
 * GATED: the strong-signal cases DO link. Without that floor an engine that
 * linked nothing would pass, which is the shape
 * `a-gate-narrow-enough-to-always-pass` warns about and the reason the corpus
 * test carries its own floor.
 *
 * REPORTED, NOT GATED: exact outcome agreement. `SUGGESTED` vs `UNMATCHED` on a
 * weak-evidence case is a judgement about how much evidence is worth showing a
 * reviewer, and this file is 15 cases — too few to move a product rule on. A
 * disagreement is printed with the case's `why` so it can be read and
 * adjudicated, which is what a held-out set is for.
 *
 * That split is deliberate: gating agreement would turn the first honest
 * disagreement into a red build and the quickest way back to green would be
 * editing the expectation, which destroys the only property this file has.
 */
import {
    reconcile,
    type EngineInput,
    type RosterEmployee,
} from '@/lib/identity/reconcile/engine';
import { step4aExtensions } from '@/lib/identity/reconcile/scorers';
import {
    engineInputFor,
    type CorpusCase,
    type Outcome,
} from '../fixtures/identity-reconcile/corpus';
import { HELD_OUT, HELD_OUT_SIZE } from '../fixtures/identity-reconcile/held-out';

function runCase(c: CorpusCase): { outcome: Outcome; employeeId: string | null; method: string } {
    const input = engineInputFor(c) as EngineInput;
    // WIRED AS PRODUCTION WIRES IT. `legacy-reconcile.ts:287` calls
    // `step4aExtensions(roster, convention)` before reconciling, so an engine
    // run without them is Step 3b alone — which is what
    // `identity-reconcile-precision.test.ts` deliberately measures, and NOT
    // what a tenant gets. My first run omitted them and all nine name-based
    // cases came back `NO_CANDIDATES`: with no blocker there is no candidate to
    // score, which reads like an engine finding and is a harness artefact.
    //
    // `convention` stays NULL on purpose: a convention is adopted per
    // connection by a human, and inferring one for a fixture is the circular
    // fit `conventions.ts` forbids.
    const { scorers, blockers, ambiguityMargin } = step4aExtensions(
        input.roster as readonly RosterEmployee[],
        null,
    );
    // `ambiguityMargin` rides with them (#3560) for the same reason the scorers
    // do: this harness's whole claim is that it wires the engine the way
    // `legacy-reconcile.ts` wires it, and omitting one config value would make
    // every outcome below measure a configuration no tenant runs. Measured
    // across both fixture sets, wiring it changes exactly ONE case — `db-02`,
    // which is in the CORPUS, not here — so nothing in this file moves.
    const r = reconcile({
        ...input,
        config: { ...input.config, scorers, blockers, ambiguityMargin },
    });
    // One account in, one resolution out. Asserted rather than assumed: a
    // builder that returned two would make every count below wrong by a factor
    // nobody would see.
    expect(r.resolutions).toHaveLength(1);
    const first = r.resolutions[0];
    return {
        outcome: first.outcome as Outcome,
        employeeId: first.employeeId ?? null,
        method: String(first.method ?? '—'),
    };
}

describe('the deterministic engine on held-out data (#3516)', () => {
    it('is a set the engine was not authored against, and says how big it is', () => {
        // The denominator beside every result below. A shrinking set would
        // otherwise make the gates easier to pass without anything being said.
        expect(HELD_OUT_SIZE).toBeGreaterThanOrEqual(15);
        expect(HELD_OUT).toHaveLength(HELD_OUT_SIZE);

        // Ids must not collide with the corpus, or `engineInputFor` would be
        // building an input the corpus test also builds and this would measure
        // the same thing twice.
        const ids = HELD_OUT.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((i) => !i.startsWith('ho2-'))).toEqual([]);
    });

    it('makes no false auto-link — the gate', () => {
        const falseLinks: string[] = [];
        const correctLinks: string[] = [];
        const disagreements: string[] = [];

        for (const c of HELD_OUT) {
            const res = runCase(c);

            if (res.outcome === 'LINKED') {
                const right =
                    c.expected.outcome === 'LINKED' && c.expected.employeeId === res.employeeId;
                if (right) correctLinks.push(c.id);
                else {
                    falseLinks.push(
                        `${c.id}: linked ${res.employeeId} via ${res.method}; the case expects ` +
                            `${c.expected.outcome} ${c.expected.employeeId ?? '(nobody)'} — ${c.why}`,
                    );
                }
            }

            if (res.outcome !== c.expected.outcome) {
                disagreements.push(
                    `${c.id} [${c.category}]: engine ${res.outcome}` +
                        `${res.employeeId ? ` -> ${res.employeeId}` : ''}` +
                        ` (${res.method}); expected ${c.expected.outcome}` +
                        `${c.expected.employeeId ? ` -> ${c.expected.employeeId}` : ''}`,
                );
            }
        }

        const expectedLinks = HELD_OUT.filter((c) => c.expected.outcome === 'LINKED');
        const agreed = HELD_OUT.length - disagreements.length;

        console.log(
            [
                '',
                '  ── Step 3b engine over the HELD-OUT set ──',
                `  cases                 ${HELD_OUT.length}`,
                `  auto-links made       ${correctLinks.length + falseLinks.length}`,
                `  false links           ${falseLinks.length}   (GATED: must be 0)`,
                `  expected links hit    ${correctLinks.length}/${expectedLinks.length}   (GATED: must be all)`,
                `  outcome agreement     ${agreed}/${HELD_OUT.length}   (REPORTED, not gated)`,
                ...(disagreements.length
                    ? ['', '  disagreements — each one is a finding to adjudicate:',
                       ...disagreements.map((d) => `    ${d}`)]
                    : ['', '  no disagreements']),
                '',
            ].join('\n'),
        );

        expect(falseLinks).toEqual([]);
    });

    it('links every case whose evidence is a STRONG signal, so the gate has a floor', () => {
        // Without this an engine that links nothing passes the gate above. The
        // four strong kinds are the only ones that can produce LINKED here —
        // no convention is declared, by design (see the fixture header).
        const missed: string[] = [];
        for (const c of HELD_OUT.filter((x) => x.expected.outcome === 'LINKED')) {
            const res = runCase(c);
            if (res.outcome !== 'LINKED' || res.employeeId !== c.expected.employeeId) {
                missed.push(
                    `${c.id}: got ${res.outcome} ${res.employeeId ?? '(nobody)'}; ` +
                        `expected LINKED ${c.expected.employeeId} — ${c.why}`,
                );
            }
        }
        expect(missed).toEqual([]);
    });

    it('never links on a signal the design classifies as supporting', () => {
        // The cases written so a STRONG kind must refuse: a name-with-counter
        // read as an employee number, a folded email domain, a stale directory
        // bridge. Each must come back as something a person confirms.
        const wrongly: string[] = [];
        for (const id of ['ho2-en-02', 'ho2-em-02', 'ho2-db-02']) {
            const c = HELD_OUT.find((x) => x.id === id);
            // Named ids, so the loop cannot silently range over nothing if a
            // case is renamed. Jest's `expect` takes ONE argument — the
            // message-as-second-arg form is Vitest's, and it throws here.
            expect(c).toBeDefined();
            const res = runCase(c as CorpusCase);
            if (res.outcome === 'LINKED') {
                wrongly.push(`${id}: linked ${res.employeeId} via ${res.method} — ${(c as CorpusCase).why}`);
            }
        }
        expect(wrongly).toEqual([]);
    });
});
