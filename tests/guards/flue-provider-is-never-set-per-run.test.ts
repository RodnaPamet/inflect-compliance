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
 * The deferral is recorded in the phase note as well as here, and the last test
 * below pins the STATE that deferral describes — because an option deferred in
 * a comment nobody reads is indistinguishable from one that was forgotten, and
 * because asserting on the note's prose is a shape two of this repo's ratchets
 * close on from opposite sides (the test says which).
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

    /**
     * Inference origins this deployment DELIBERATELY admits, each with the
     * reason it cannot be removed. Anything reachable and not listed here is a
     * finding; anything listed and no longer reachable is a stale entry to
     * delete, which the exact-set assertion below also catches.
     */
    const ADMITTED_WITH_REASON: ReadonlyArray<{ readonly host: string; readonly why: string }> = [
        {
            host: 'aiplatform.googleapis.com',
            why:
                'the GCP plugin audits Vertex AI configuration, and the same origin serves ' +
                ':predict / :generateContent — no host-level rule can permit one and deny the ' +
                'other. Closing it needs an L7 method/path rule (4.1, #3961).',
        },
        {
            host: 'bedrock-runtime.us-east-1.amazonaws.com',
            why:
                'admitted by `*.amazonaws.com`, which is still a wildcard: AWS endpoints are ' +
                'regional, so a per-service list is region-parameterised and much larger than ' +
                "GCP's. Not yet derived (4.1, #3961).",
        },
    ];

    it.each(BENCHMARKS)('%s names no UNEXPLAINED inference endpoint', (benchmark) => {
        // Named outright is now ALLOWED for a listed origin, because 4.1
        // narrowed GCP from `*.googleapis.com` to an explicit per-service list
        // and `aiplatform.googleapis.com` had to survive it — the plugin audits
        // Vertex AI, and that audit shares an origin with Vertex AI inference.
        // Naming it is better than admitting it by wildcard: it is now a
        // reviewed line with a reason beside it.
        const hosts = collectorSandboxPolicy(benchmark).networkPolicies.map((e) => e.host);
        expect(hosts.length).toBeGreaterThan(0);
        const explained = new Set(ADMITTED_WITH_REASON.map((a) => a.host));
        const named = hosts.filter((h) => INFERENCE_HOSTS.includes(h) && !explained.has(h));
        expect(named).toEqual([]);
    });

    it('records exactly which inference hosts are reachable, and why each is', () => {
        // The exact set, as before, but now every member carries a reason. 4.1
        // removed `generativelanguage.googleapis.com` from this list by dropping
        // the GCP wildcard — the first of the two holes 4.4 found, closed.
        const admitted = BENCHMARKS.flatMap((b) =>
            INFERENCE_HOSTS.filter((h) => admits(b, h)).map((h) => `${b} -> ${h}`),
        );
        expect(admitted.sort()).toEqual([
            // Still a wildcard, and the reason is in ADMITTED_WITH_REASON.
            'aws_compliance.benchmark.soc_2 -> bedrock-runtime.us-east-1.amazonaws.com',
            // Explicit now, not by wildcard, and irreducible at host level.
            'gcp_compliance.benchmark.cis_v300 -> aiplatform.googleapis.com',
        ]);

        // Every reachable inference origin is explained, and every explanation
        // still describes something reachable — a stale reason is as misleading
        // as a missing one.
        const reachable = new Set(admitted.map((a) => a.split(' -> ')[1]));
        expect(ADMITTED_WITH_REASON.map((a) => a.host).sort()).toEqual([...reachable].sort());
        for (const a of ADMITTED_WITH_REASON) expect(a.why.length).toBeGreaterThan(60);
    });

    it('the GCP wildcard is gone, and generativelanguage is no longer reachable', () => {
        // The improvement itself, asserted rather than left implicit in a diff.
        const gcp = collectorSandboxPolicy('gcp_compliance.benchmark.cis_v300');
        expect(gcp.networkPolicies.filter((e) => e.host.startsWith('*.'))).toEqual([]);
        expect(admits('gcp_compliance.benchmark.cis_v300', 'generativelanguage.googleapis.com')).toBe(
            false,
        );
        // And the narrowing did not empty the list: the derived per-service set
        // is substantial, so an accidental truncation to nothing fails here.
        expect(gcp.networkPolicies.length).toBeGreaterThanOrEqual(30);
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
    it('the per-residency-class backstop is still deferred, not quietly half-built', () => {
        // #3966's third requirement, held as a STATE rather than as a sentence
        // in a document — and that choice was forced, which is worth recording.
        //
        // Reading the phase note and asserting it contains the record is the
        // obvious move, and it is the one shape this repo will not take. An
        // unmasked read-and-assert puts the file in Class A of
        // `raw-source-assertion-ratchet` (zero headroom, two listed files);
        // masking it to escape that puts it in Class D of
        // `assertion-needle-uniqueness` as `content-transformed`. The two
        // ratchets close on prose assertions from both sides, deliberately.
        //
        // So this asserts the thing the deferral is ABOUT. A per-residency-class
        // backstop means a policy that varies by residency class, and this one
        // cannot: it is keyed by benchmark and takes nothing else. Implementing
        // the backstop changes that signature, which fails here — and whoever
        // changes it is then standing in front of the record above, which is
        // the whole point of not forgetting.
        expect(collectorSandboxPolicy.length).toBe(1);
        const once = collectorSandboxPolicy('gcp_compliance.benchmark.cis_v300');
        const twice = collectorSandboxPolicy('gcp_compliance.benchmark.cis_v300');
        // Nothing ambient varies it either — no tenant, no residency class read
        // from somewhere else and folded in.
        expect(JSON.stringify(twice)).toEqual(JSON.stringify(once));
    });
});
