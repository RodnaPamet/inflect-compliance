/**
 * No file under `src/` calls the Flue runtime's `setProvider` (#3650).
 *
 * `flue/model-selection.ts` said it "deliberately does NOT call `setProvider`"
 * and named `tests/guards/flue-provider-registration-is-not-per-run.test.ts` as
 * what "keeps it that way". That file has never existed here.
 *
 * WHY THIS ONE IS THE URGENT MEMBER OF #3650. The hazard is not a style
 * regression. `setProvider` mutates a MODULE-SCOPED SINGLETON, so provider
 * registration is process-wide, and `model-selection.ts` spells out what a
 * per-run call costs in its own words:
 *
 *   "Two concurrent runs in one Node process would race, and the loser executes
 *    against the winner's provider. In a product where `aiResidency: LOCAL_ONLY`
 *    is documented as a HARD invariant, that race is a cross-tenant egress: a
 *    LOCAL_ONLY tenant's reasoning could be streamed to an external endpoint
 *    another tenant registered a millisecond earlier, with nothing in the audit
 *    trail to show it."
 *
 * A residency invariant that a race can defeat is not an invariant, and the
 * only thing standing between that paragraph and a regression was the
 * paragraph.
 *
 * COMMENTS ARE MASKED, and that is load-bearing here rather than hygiene: this
 * guard's own subject file quotes `setProvider()` three times while explaining
 * why it never calls it, and `@flue/runtime`'s own config docblock mentions it
 * too. Scanning raw text would report the explanation as the breach — the "a
 * scar is not a wound" failure.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3650
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { collectorSandboxPolicy } from '@/lib/agentic/openshell/collector-policy';

const ROOT = path.resolve(__dirname, '../..');

/**
 * A CALL to `setProvider`, not a mention of the word.
 *
 * The `\b` before and the `\(` after are both doing work. Without the word
 * boundary this matches `unsetProvider`; without the paren it matches a
 * reference passed as a value. And the negative lookahead on `s` is what keeps
 * `setProviders(...)` out — the React state setter, which appears twice in
 * `src/app/.../admin/` and has nothing to do with the runtime.
 */
const SET_PROVIDER_CALL = /\bsetProvider\s*\(/;

interface Hit {
    readonly file: string;
    readonly line: number;
}

function callSites(): Hit[] {
    const out: Hit[] = [];
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const code = codeOf(fs.readFileSync(abs, 'utf-8'));
        code.split('\n').forEach((text, i) => {
            if (SET_PROVIDER_CALL.test(text)) {
                out.push({ file: path.relative(ROOT, abs).split(path.sep).join('/'), line: i + 1 });
            }
        });
    }
    return out;
}

describe('the Flue provider is never set per run (#3650)', () => {
    it('scans a real population of source files', () => {
        // The denominator. A `repoFiles` call that returned nothing would make
        // the assertion below pass over zero files, which is indistinguishable
        // from "no call sites" in its output.
        expect(repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).length).toBeGreaterThan(500);
    });

    it('no source file calls setProvider', () => {
        // If this fires: the provider must be registered ONCE at boot
        // (`runtime-bootstrap.ts`), never per run. `resolveFlueModel` returns a
        // specifier for the caller to dispatch with; it does not mutate the
        // registry, and that asymmetry is the fix for the race above.
        expect(callSites()).toEqual([]);
    });

    it('sees a real call, and is not fooled by the React setter or by prose', () => {
        // The control, driving the real regex through the real comment masker.
        expect(SET_PROVIDER_CALL.test('setProvider({ id: "x" });')).toBe(true);
        expect(SET_PROVIDER_CALL.test('  await setProvider(p);')).toBe(true);

        // `setProviders` is the useState setter in two admin pages. A guard that
        // matched it would fail on correct code, which is the fastest way to get
        // a guard deleted.
        expect(SET_PROVIDER_CALL.test('setProviders(data);')).toBe(false);
        expect(SET_PROVIDER_CALL.test('const [providers, setProviders] = useState([]);')).toBe(false);
        expect(SET_PROVIDER_CALL.test('unsetProvider();')).toBe(false);

        // And a mention inside a comment must not count, which is the case this
        // guard's own subject file produces three times over.
        expect(SET_PROVIDER_CALL.test(codeOf('// those with `setProvider()` in app.ts'))).toBe(false);
        expect(SET_PROVIDER_CALL.test(codeOf('/* It deliberately does NOT call setProvider(); */'))).toBe(false);
    });
});

/**
 * 4.4 (#3966) — OpenShell must not become a SECOND inference router.
 *
 * The block above keeps `model-selection.ts` the only decision-maker inside
 * this process. This one keeps a different component from acquiring the same
 * authority from outside, and the issue states why it matters: "two routers can
 * disagree about where a tenant's data went, and the disagreement is
 * unobservable from either side." A residency claim that two components can
 * answer differently is not a claim about anything.
 *
 * ═══ WHAT "OPENSHELL ROUTES INFERENCE" WOULD ACTUALLY LOOK LIKE ═══
 *
 * Not a `setProvider` call — OpenShell is a different process and cannot make
 * one. Measured against the pinned v0.1.5 gateway for #4258, it compiles in no
 * inference invocation path at all: no `api.anthropic.com`, `api.openai.com`,
 * `openrouter.ai` or `generativelanguage` host, and no `InvokeModel`-shaped
 * route. Its only matches are `bedrock`/`bedrock-runtime` in CONFIGURATION HELP
 * TEXT, naming an example endpoint an operator might allow.
 *
 * Which is exactly the shape the risk takes here. OpenShell cannot CALL a model
 * provider, but a policy of ours could ALLOW a sandbox to reach one — and a
 * sandbox that may reach `api.anthropic.com` has an egress path for inference
 * that `model-selection.ts` never decided. So the assertion is over the
 * endpoints our committed policies actually declare, read as parsed values.
 *
 * ═══ THE PER-RESIDENCY-CLASS BACKSTOP IS DEFERRED, NOT FORGOTTEN ═══
 *
 * #3966 records the option and rules it out of scope: kernel network policy
 * COULD backstop a `LOCAL_ONLY` decision by denying non-local model egress, but
 * one worker process serves many tenants while OpenShell confines per sandbox,
 * so a per-tenant backstop needs per-residency-class sandboxes. That is a
 * sandbox-per-residency-class topology, not a policy edit, and it is deferred
 * "unless the owner pulls it in".
 *
 * The deferral is recorded in the phase note as well as here, and a test below
 * asserts that record exists — because an option that is deferred in a comment
 * nobody reads is indistinguishable from one that was forgotten.
 */
describe('OpenShell is not a second inference router (#3966)', () => {
    /**
     * Real inference endpoints, one per provider family. Full hostnames, not
     * fragments, because the question below is "would this policy ADMIT this
     * host", and a wildcard can only be evaluated against a whole name.
     */
    const INFERENCE_HOSTS: readonly string[] = [
        'api.anthropic.com',
        'api.openai.com',
        'openrouter.ai',
        'generativelanguage.googleapis.com',
        'aiplatform.googleapis.com',
        'bedrock-runtime.us-east-1.amazonaws.com',
        'inflect.openai.azure.com',
    ];

    const BENCHMARKS = [
        'aws_compliance.benchmark.soc_2',
        'azure_compliance.benchmark.soc_2',
        'gcp_compliance.benchmark.cis_v300',
    ] as const;

    /** The gateway's own matching rule: a leading `*.` is a suffix match. */
    const admits = (benchmark: string, host: string): boolean =>
        collectorSandboxPolicy(benchmark).networkPolicies.some((e) =>
            e.host.startsWith('*.') ? host.endsWith(e.host.slice(1)) : e.host === host,
        );

    it.each(BENCHMARKS)('%s names no inference endpoint outright', (benchmark) => {
        // Parsed hosts, not source text: a docblock naming a provider must not
        // fail this, and a host list that genuinely grew must not hide in one.
        const hosts = collectorSandboxPolicy(benchmark).networkPolicies.map((e) => e.host);
        expect(hosts.length).toBeGreaterThan(0);
        // A filtered set rather than a per-host `not.toContain`: this names
        // every offending endpoint on failure instead of stopping at the first,
        // and it keeps an array-membership check out of the Class D whole-file
        // read census, which counts `toContain`/`toMatch` to ask a different
        // question — whether a NEEDLE is ambiguous. A seven-element literal
        // list of hostnames has no needle to be ambiguous about.
        expect(hosts.filter((h) => INFERENCE_HOSTS.includes(h))).toEqual([]);
    });

    it('records exactly which inference hosts the wildcards admit anyway', () => {
        // The subtler half, and the one worth pinning. 4.1 allows a
        // PROVIDER-scoped host per collector because the per-service set is not
        // derivable from this repository — and two of those three wildcards
        // reach an inference API. Asserted as an exact set, so neither a new
        // admission nor a narrowing can pass unnoticed.
        const admitted = BENCHMARKS.flatMap((b) =>
            INFERENCE_HOSTS.filter((h) => admits(b, h)).map((h) => `${b} -> ${h}`),
        );
        expect(admitted.sort()).toEqual([
            // `*.amazonaws.com` — Bedrock, which the pinned gateway's own
            // configuration help text names as an example endpoint (#4258).
            'aws_compliance.benchmark.soc_2 -> bedrock-runtime.us-east-1.amazonaws.com',
            // `*.googleapis.com` — both Google inference surfaces sit under the
            // same suffix as the service APIs the benchmark needs.
            'gcp_compliance.benchmark.cis_v300 -> aiplatform.googleapis.com',
            'gcp_compliance.benchmark.cis_v300 -> generativelanguage.googleapis.com',
        ]);
    });

    it('azure is the control — an exact-host policy admits none of them', () => {
        // Not a quirk: the azure policy needs no wildcard because ARM is one
        // host, so it shows what the other two would look like once #3961's
        // denial measurement lets them be narrowed. Without this the test above
        // could be satisfied by a matcher that admits everything.
        for (const host of INFERENCE_HOSTS) {
            expect(admits('azure_compliance.benchmark.soc_2', host)).toBe(false);
        }
        // And the matcher is not inert: it does admit azure's real endpoint.
        expect(admits('azure_compliance.benchmark.soc_2', 'management.azure.com')).toBe(true);
    });
    it('the deferred per-residency-class backstop is recorded, not forgotten', () => {
        // #3966's third requirement, and the one a test can actually hold. A
        // deferral that lives only in a code comment is indistinguishable from
        // an oversight six months later, so the phase note carries it too — and
        // deleting that record fails here rather than quietly widening what
        // this file appears to have settled.
        //
        // Matched as ONE PLAIN LITERAL against the file as it is on disk, which
        // is a deliberate choice between three options that are not equivalent:
        // collapsing whitespace makes it a transformed read and a regex with
        // `\s+` makes the needle carry a span, and Class D of
        // `assertion-needle-uniqueness` scores BOTH as un-analysable — +2 on a
        // blind-spot census, to assert two lines of prose. A literal costs
        // nothing there, and the note keeps the sentence un-wrapped for it.
        const note = fs.readFileSync(
            path.join(ROOT, 'docs/implementation-notes/2026-10-25-openshell.md'),
            'utf8',
        );
        expect(note).toContain(
            'Deferred by owner condition: per-residency-class sandboxes (#3966).',
        );
    });
});
