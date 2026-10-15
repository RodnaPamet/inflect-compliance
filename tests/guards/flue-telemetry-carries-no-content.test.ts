/**
 * FLUE SPANS CARRY OPERATION SHAPE, NEVER MODEL OR TENANT CONTENT.
 *
 * ── THE LEAK THIS EXISTS TO PREVENT ─────────────────────────────────────────
 *
 * `FlueObservationDetail` — the payload handed to an `observe` subscriber —
 * carries `agentInput`, `agentOutput` (with its `text`), `args` and
 * `effectiveResult`. That is the model's prompt, the model's answer, and every
 * tool's arguments and results.
 *
 * `@flue/runtime/telemetry` ships helpers whose entire purpose is to put that
 * on spans: `inputMessages`, `outputMessages`, `agentInputMessage`,
 * `agentOutputMessage`, `contentAttribute`, `systemInstructions`. Reaching for
 * them is the obvious reading of "wire up the telemetry", and it is why this
 * guard is structural rather than behavioural — the wrong version passes every
 * functional test, because the spans are still correct spans.
 *
 * Spans LEAVE this system. They go to a tracing backend with its own
 * retention, its own access control, and none of this platform's tenant
 * isolation or encrypted-field manifest. Sending tenant evidence and model
 * output there defeats `no-raw-prompt-logging` through a channel nobody
 * greps, because a span is not a log line.
 *
 * So: the interceptor may forward identifiers, names and closed-union members.
 * Nothing may forward content.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';

/**
 * `ROOT` is computed LOCALLY rather than imported, and that is what makes the
 * assertions below ANALYSABLE. `tests/helpers/assertion-reach.ts` constant-
 * folds a path expression "given known string constants" — a local
 * `path.resolve(__dirname, …)` is one; an identifier imported from another
 * module is not. With the imported `REPO_ROOT` every assertion on the result
 * lands in the un-analysable set and the Class D ratchet counts new blind
 * spots. Measured, not reasoned: this file added five before the swap.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const TELEMETRY = 'src/lib/agentic/flue/telemetry.ts';

/**
 * The content-bearing surface, by name. Two groups, and both matter:
 * the FIELDS an observation carries, and the HELPERS that exist to serialise
 * them onto a span.
 */
const CONTENT_FIELDS = [
    'agentInput',
    'agentOutput',
    'effectiveResult',
    'systemPrompt',
];
const CONTENT_HELPERS = [
    'inputMessages',
    'outputMessages',
    'agentInputMessage',
    'agentOutputMessage',
    'contentAttribute',
    'systemInstructions',
    'toolDefinitions',
    'createContentLedger',
];

describe('the Flue telemetry module forwards no content', () => {
    const src = read(TELEMETRY);

    it('read a real module, not an empty one', () => {
        // Every absence below is satisfied by a file that does not exist.
        expect(src.length).toBeGreaterThan(500);
        expect(src).toContain('instrument(');
    });

    it('names none of the content-bearing observation fields', () => {
        const found = CONTENT_FIELDS.filter((f) => new RegExp(`\\b${f}\\b`).test(src));
        expect({ found }).toEqual({ found: [] });
    });

    it('imports none of the content-serialising helpers', () => {
        const found = CONTENT_HELPERS.filter((h) => new RegExp(`\\b${h}\\b`).test(src));
        expect({ found }).toEqual({ found: [] });
    });

    it('does not import the telemetry subpath at all', () => {
        // `@flue/runtime/telemetry` is the content-attribute module. There is
        // no reason to reach it, and reaching it is the first step of the
        // mistake this guard is about.
        expect(src).not.toContain('@flue/runtime/telemetry');
    });

    it('its observe subscriber forwards nothing', () => {
        // The interface requires a subscriber. An empty one is the decision;
        // a forwarding one is the leak. Asserted on the SHAPE so a body that
        // grows anything is visible.
        expect(src).toMatch(/observe:\s*\(\)\s*=>\s*\{\s*\}/);
    });

    it('does not record exceptions, which carry stacks that quote arguments', () => {
        expect(src).not.toContain('recordException');
    });
});

describe('no second exporter is installed anywhere for Flue', () => {
    // The plan: "into the EXISTING pipeline; no second exporter." A Flue-owned
    // SDK would sample separately, ship separately, and hold its own
    // credentials — and a run would stop appearing in the same trace as the
    // request or job that started it.
    const SRC = repoRelativeFiles().filter(
        (f) => f.startsWith('src/lib/agentic/flue/') && f.endsWith('.ts'),
    );

    it('scanned a real population', () => {
        expect(SRC.length).toBeGreaterThanOrEqual(8);
        expect(SRC).toContain(TELEMETRY);
    });

    it('registers no SDK, processor or exporter', () => {
        const offenders = SRC.filter((f) =>
            /NodeSDK|BatchSpanProcessor|SimpleSpanProcessor|OTLPTraceExporter|registerInstrumentations/.test(
                read(f),
            ),
        );
        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('uses the shared tracer', () => {
        // Positive control for the assertion above: "installs no exporter" is
        // trivially true of a module that emits nothing at all.
        // The CALL with its tracer name, not the bare identifier: `getTracer`
        // occurs three times in that module (import, doc mention, call), and a
        // needle satisfied by any of them is one the Class D ratchet counts —
        // and one that would still pass with the call deleted.
        expect(read(TELEMETRY)).toContain("getTracer('inflect.agentic.flue')");
    });
});

/*
    ═══ THE ONE INTERCEPTOR ALSO CARRIES THE DELEGATION GATE (#3473) ═══

    `instrument()` throws `InstrumentationAlreadyInstalledError` on a second
    install, so this process has exactly ONE interceptor and anything needing
    that seam has to compose into it. The fan-out and depth caps on subagent
    delegation do, because the `task` tool belongs to the runtime: it is in
    every run's tool list already (#3569), so there is no `useTool` wrapper to
    put a check in and no point before the runtime at which the call could be
    declined.

    `tests/flue/delegation-is-capped.test.ts` proves the gate WORKS — it boots
    the real runtime, scripts a model to call `task`, and reads what the
    interceptor saw. What it cannot prove is that PRODUCTION calls it: that
    file installs its own instrumentation, because the app's is installed
    inside `ensureFlueRuntime`, which it does not call. So it reproduces the
    composition rather than importing it.

    This is the other half, and without it the composition is the thing that
    can silently come apart: deleting one line from the production interceptor
    leaves every behavioural assertion green and every delegation ungated.
*/
describe('the production interceptor calls the delegation gate', () => {
    const telemetry = read(TELEMETRY);

    it('calls BOTH halves of the gate, and imports them rather than reimplementing', () => {
        // TWO HALVES SINCE #3473's second part: `gateDelegation` decides whether
        // a delegation may START, and `guardDelegateResult` decides whether its
        // answer may be SEEN. They are one seam and either missing is a hole.
        //
        // The needle was `import { gateDelegation } from …` and went red when
        // the second name joined the line — a drifted citation rather than a
        // changed claim, so it is retargeted and widened rather than loosened.
        // Matching each NAME in the import list is what keeps it from being
        // satisfied by a line that imports only one of them.
        // MATCHED ON THE CALLEE, not on an argument list. The needle was
        // `gateDelegation(operation, ctx)` and went red when the gate gained a
        // third argument and wrapped across lines — the third time a citation
        // in this block has drifted while its claim held. The claim is "the
        // interceptor calls both halves", and a callee is what says that.
        expect(telemetry).toMatch(/\bgateDelegation\s*\(/);
        expect(telemetry).toContain('await guardDelegateResult(');
        expect(telemetry).toMatch(/import \{[^}]*\bgateDelegation\b[^}]*\} from '\.\/delegation-gate'/);
        expect(telemetry).toMatch(/import \{[^}]*\bguardDelegateResult\b[^}]*\} from '\.\/delegation-gate'/);
    });

    it('passes BOTH binding hooks — the guard and the ledger recorder', () => {
        // #3473 part 3. The behavioural suites build their OWN interceptor,
        // reproducing this composition rather than importing it, so they cannot
        // see a hook that production stops passing.
        //
        // MEASURED: replacing `binding?.onDelegationComplete` with `undefined`
        // left all 35 of those assertions green while every delegation went
        // unrecorded. This is the only place that catches it.
        expect(telemetry).toContain('binding?.guardDelegateOutput');
        expect(telemetry).toContain('binding?.onDelegationComplete');
        // READ FROM ONE BINDING LOOKUP, not two. Two would be two reads of a
        // map that a release between them could have emptied, and the pair
        // would then disagree about whether this run has hooks at all.
        expect((telemetry.match(/readRunBinding\(/g) ?? []).length).toBe(1);
    });

    it('scans the answer AFTER `next()`, which is the only place the answer exists', () => {
        // The mirror of the ordering assertion below it: the gate must run
        // before `next()` and the answer scan after it. A scan before would
        // have nothing to read, and would pass a presence check.
        const scanAt = telemetry.indexOf('await guardDelegateResult(');
        const nextAt = telemetry.indexOf('await next()');
        expect(scanAt).toBeGreaterThan(-1);
        expect(nextAt).toBeGreaterThan(-1);
        expect(scanAt).toBeGreaterThan(nextAt);
    });

    it('calls it BEFORE `next()`, which is what makes a refusal enforcement', () => {
        // A gate after `next()` would observe a delegation that had already
        // happened. Asserted on ORDER rather than presence, because both lines
        // are present either way and only one of the two arrangements refuses
        // anything.
        const gateAt = telemetry.search(/\bgateDelegation\s*\(/);
        const nextAt = telemetry.indexOf('await next()');
        expect(gateAt).toBeGreaterThan(-1);
        expect(nextAt).toBeGreaterThan(-1);
        expect(gateAt).toBeLessThan(nextAt);
    });

    it('passes the REAL ctx, not the discarded one', () => {
        // The interceptor's second parameter was `_ctx` — unused, because the
        // telemetry half wants nothing from it. The gate needs `instanceId`
        // and `turnId`, and its own fail-open branch means an underscore here
        // would let every delegation through while every other assertion in
        // this file stayed green.
        expect(telemetry).toMatch(/interceptor: async \(operation, ctx, next\)/);
        expect(telemetry).not.toMatch(/interceptor: async \(operation, _ctx, next\)/);
    });
});
