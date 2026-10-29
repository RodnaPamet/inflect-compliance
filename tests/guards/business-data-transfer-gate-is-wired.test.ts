/**
 * THE TRANSFER GATE IS CALLED, AND CALLED IN THE ONLY CORRECT WINDOW
 * (M5, #3872).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, MEASURED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `external-residency-gate.ts` is pure and has nine unit tests; the
 * acknowledgement has thirteen integration tests on real rows. Deleting the
 * gate's CALL SITE in `flue/execute.ts` leaves **all twenty-two green** — they
 * exercise the decision and the storage, and neither of them is the wiring.
 * That was measured, not supposed, and it is the third time this shape has
 * appeared in this subsystem: an injected reader leaves the SEAM untested.
 *
 * A behavioural test cannot easily stand here. `flue/execute.ts` statically
 * imports `@flue/runtime`, which is ESM-only with no `require` condition, so no
 * CJS suite can load it — the reason the driver reaches it by dynamic import at
 * all. So this is structural, as `flue-step-links-its-decision-row` is, and for
 * the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WINDOW IS THE PROPERTY, NOT JUST THE CALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A gate that runs AFTER the first model call has not prevented a transfer; it
 * has reported one. A gate that runs BEFORE the offer is built would judge
 * tools the model cannot reach, which is the opposite error — it would refuse
 * runs over connections whose business-system tools were all withheld.
 *
 * So the ordering assertions below are the substance. Reads are
 * comment-stripped at the seam: a needle satisfied by a docstring would make
 * this a check on prose, which is what `raw-source-assertion-ratchet` exists to
 * refuse and what it caught in this guard's sibling.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
const DRIVER = 'src/lib/agentic/flue/driver.ts';
const OFFER = 'src/lib/agentic/engine-tools/offer-tools.ts';

describe('the engine calls the gate', () => {
    it('`executeFlueRun` reaches `externalResidencyRefusal`', () => {
        expect(read(EXECUTE)).toContain('externalResidencyRefusal({');
    });

    it('and settles the run on a refusal rather than continuing', () => {
        // Not merely computing the verdict. A call whose result was ignored
        // would satisfy the assertion above and permit every transfer.
        const src = read(EXECUTE);
        const at = src.indexOf('externalResidencyRefusal({');
        const after = src.slice(at, at + 1200);
        expect(after).toContain('if (transferRefusal) {');
        expect(after).toContain('failRun(ctx, runId, transferRefusal.message)');
    });
});

describe('and calls it in the window where it can still prevent the transfer', () => {
    const src = () => read(EXECUTE);

    it('AFTER the offered set is built, so it judges what the model can reach', () => {
        const s = src();
        const offer = s.indexOf('const offered = flueToolsFor(');
        const gate = s.indexOf('externalResidencyRefusal({');
        expect(offer).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(offer);
    });

    it('BEFORE the first model call, so a refusal prevents rather than reports', () => {
        // `agent.read(...)` is where the run first reaches the model. A gate
        // below it would run after the bytes had already left.
        const s = src();
        const gate = s.indexOf('externalResidencyRefusal({');
        const modelCall = s.indexOf('agent.read(');
        expect(modelCall).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(modelCall);
    });
});

describe('the terms it reads are supplied, not defaulted away', () => {
    it('the driver reads the acknowledgement and hands it down', () => {
        // The gate treats an absent acknowledgement as unacknowledged, which
        // REFUSES — so a driver that stopped passing it would fail closed
        // rather than open. That is the safe direction and still wrong: every
        // run over a marked connection would refuse with no way to proceed.
        const s = read(DRIVER);
        expect(s).toContain('EXTERNAL_AI_ACK_SELECT');
        expect(s).toContain('externalAiAcknowledgement:');
    });

    it('and the offer reports the connections the gate ranges over', () => {
        // Without this the gate's `offered` list is always empty and it can
        // never refuse — the fail-OPEN direction, and the one worth guarding.
        const s = read(OFFER);
        expect(s).toContain('externalConnections.push(tool.externalConnection)');
        expect(read(EXECUTE)).toContain('offered.externalConnections.map(');
    });

    it('and the residency it compares is the run`s own provider', () => {
        // `providerIdOf(modelSpecifier)`, not a tenant column re-read here: the
        // specifier is what the run will actually dial, and a second read could
        // disagree with it.
        expect(read(EXECUTE)).toContain('providerIdOf(modelSpecifier)');
    });
});
