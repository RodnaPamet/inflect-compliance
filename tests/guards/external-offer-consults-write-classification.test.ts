/**
 * READ-ONLY STAYS READ-ONLY, AT THE OFFER AS WELL AS THE DISPATCH (M5, #3872).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS LOCKS, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dispatchWrite` has always refused a write on a connection at the ladder's
 * `DISABLED` rung: it handles `DRY_RUN`, `PROPOSE_ONLY` and `AUTOMATIC` and
 * falls through to a refusal that sends nothing. That half needs no guard — it
 * fails closed by construction, and an unhandled rung lands in the same arm.
 *
 * The half that needed one is the OFFER. Until #3872 the offered set consulted
 * neither the write classification nor the connection's rung, so such a tool
 * was advertised to the model and refused on every call — the mismatch the
 * AUTONOMY omission beside it already exists to prevent, one axis over.
 *
 * So this guard is about the three joints that make the offer-time narrowing
 * TRUE rather than present:
 *
 *   1. every external tool reaching an offer carries the two terms,
 *   2. there is exactly ONE producer of them, so a second path cannot build
 *      adapters without the metadata and silently pass the gate, and
 *   3. the offer actually branches on both terms.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT ASSERT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does NOT forbid `=== 'DISABLED'` outside the ladder module. That was the
 * first shape I tried, and measuring it first is what killed it: the
 * comparison appears legitimately in SIXTEEN files under `src/` — the identity
 * ladder's own rung checks, the external write policy, the joiner and leaver
 * passes, the service-principal disable. A guard over that population would
 * report fifteen innocent sites forever, which is a guard nobody keeps.
 *
 * The narrow true statement is the one asserted below: the OFFER path does not
 * spell the rung comparison itself, because it has a predicate for it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LADDER = 'src/lib/integrations/external-write-ladder.ts';
const ADAPTER = 'src/lib/mcp/tools/external-tools.ts';
const OFFER = 'src/lib/agentic/engine-tools/offer-tools.ts';
const TYPES = 'src/lib/mcp/tools/types.ts';

describe('the fourth rung has a predicate, and it lives in one place', () => {
    it('`refusesEveryWrite` is defined in the ladder beside its three siblings', () => {
        const body = functionBodyOf(read(LADDER), 'refusesEveryWrite');
        // Bound to the function, not the file: the module quotes 'DISABLED' in
        // several docstrings and in `coerceStoredMode`'s own fallbacks.
        expect(body).toContain("=== 'DISABLED'");
    });

    it('and the offer path does NOT spell the rung comparison itself', () => {
        // The one narrow statement that survives measurement. A second
        // definition of read-only would drift from the dispatch in the
        // direction that offers a tool every call to which is refused.
        expect(codeOf(read(OFFER))).not.toContain("'DISABLED'");
    });
});

describe('every external tool reaching an offer carries the two terms', () => {
    it('`adapterFor` sets both, derived rather than literal', () => {
        const src = read(ADAPTER);
        const body = functionBodyOf(src, 'adapterFor');

        // Derived from the same values the dispatch branches on. Pinning the
        // CALL rather than the field name is what makes this about provenance:
        // `connectionRefusesWrites: false` would satisfy a field-name check.
        expect(body).toContain('refusesEveryWrite(connection.mode)');
        expect(body).toContain('declaresWrite(def.annotations)');

        // An A2A send is a write whatever its definition says, exactly as the
        // dispatch's own A2A branch sits above its read/write split.
        expect(body).toMatch(/send\.kind === 'a2a' \? true :/);
    });

    it('the field is optional on the tool type, so an INTERNAL tool is not forced to lie', () => {
        // An internal tool has no connection and no rung. Making the field
        // required would mean inventing values for ~40 tools, and whichever
        // default was chosen would be wrong in one direction.
        expect(read(TYPES)).toContain('externalWrite?: ExternalWriteOffer');
    });
});

describe('there is exactly ONE producer of an invocation`s external tools', () => {
    /**
     * The joint that makes assertion 1 worth anything. If a second path built
     * adapters, they would arrive with no `externalWrite` and the offer's check
     * would skip them — passing, silently, for exactly the tools it exists to
     * withhold. Same shape as the single-write-seam guards elsewhere in this
     * directory.
     */
    const producers = (): string[] =>
        repoRelativeFiles()
            .filter((f) => f.startsWith('src/') && f.endsWith('.ts'))
            .filter((f) => /^\s*externalTools[,:]/m.test(codeOf(read(f))));

    it('the population is non-trivial, so the assertion below ranges over something', () => {
        // Without this an empty selection would pass the equality and prove
        // nothing — the failure mode this repo's guard culture already names.
        expect(producers().length).toBeGreaterThan(0);
    });

    it('and that producer is the invocation builder, nothing else', () => {
        // `authorize.ts` DECLARES the field on the invocation type; `auth.ts`
        // populates it from `resolveExternalReadTools`. A third file here is a
        // second producer and must either go through `adapterFor` or be added
        // deliberately with its own reason.
        expect(producers().sort()).toEqual(['src/lib/mcp/auth.ts', 'src/lib/mcp/authorize.ts']);
    });

    it('and it populates the field from the one resolver', () => {
        expect(read('src/lib/mcp/auth.ts')).toContain('resolveExternalReadTools(');
    });
});

describe('the offer branches on BOTH terms and records the withholding', () => {
    it('a write-classified tool whose connection refuses writes is omitted', () => {
        const body = functionBodyOf(read(OFFER), 'offerTools');
        // Both terms in one condition. Either alone would be wrong: the write
        // classification alone would withhold every write tool on every
        // connection, and the rung alone would withhold the READS the M-route
        // exists to make.
        expect(body).toContain(
            'if (tool.externalWrite?.declaresWrite && tool.externalWrite.connectionRefusesWrites) {',
        );
        expect(body).toContain("reason: 'CONNECTION_READ_ONLY'");
    });

    it('the reason is in the omission union, so a rename is a compile error', () => {
        // `ToolOmissionReason` is what the engines and the run record carry.
        // A reason pushed but not declared would not compile; this asserts the
        // declaration exists so the push above cannot be quietly widened to a
        // string.
        expect(read(OFFER)).toContain("| 'CONNECTION_READ_ONLY'");
    });

    it('the withholding is DIAGNOSTIC — the dispatch still refuses independently', () => {
        // The offer is not the enforcement and must never be read as it. If a
        // tool somehow reached dispatch anyway, `dispatchWrite`'s fall-through
        // refuses with nothing sent. Asserted here because deleting that arm
        // while keeping this guard green would leave the product relying on an
        // omission list the model is free to ignore.
        const body = functionBodyOf(read(ADAPTER), 'dispatchWrite');
        expect(body).toContain('Nothing was sent.');
    });
});
