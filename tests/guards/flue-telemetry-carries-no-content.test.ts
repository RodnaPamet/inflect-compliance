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
