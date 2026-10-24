/**
 * The scanner's OpenShell source over a fake gateway (#3936, #3937, #3945).
 *
 *   1. ONE AGENT PER SANDBOX, with credentials by reference and NO policy
 *      content: the fake's policy carries marker strings in every member the
 *      source must not keep, and none appears in the observation.
 *   2. THE PROTO'S ZERO VALUE IS NOT ENFORCEMENT. This is the suite's reason to
 *      exist. `NETWORK_ENFORCEMENT_MODE_UNSPECIFIED = 0` is documented as
 *      "log violations and allow traffic", and in proto3 a field set to its zero
 *      is indistinguishable on the wire from one never set or one dropped in
 *      transit. So audit, unspecified, absent and unrecognised must ALL fail
 *      every criterion, and each is driven separately here.
 *   3. BEST-EFFORT LANDLOCK IS NOT CONFINEMENT — and no criterion is raised
 *      from the landlock mode at all, in either direction.
 *   4. READ-ONLY BY THE CALL LOG: every call the source makes is one of
 *      `OPENSHELL_METHODS`, and the fake would happily serve a mutation if one
 *      were attempted — the three it must never make are asserted absent by
 *      name.
 *   5. INCOMPLETE WITH A NAMED REASON: a timed-out gateway, a rate-limited one
 *      and a torn listing each stop the read with a reason of its own, and what
 *      WAS read is still reported.
 */
import {
    credentialOf,
    enforcementWord,
    MAX_SANDBOXES,
    OPENSHELL_METHODS,
    OPENSHELL_PROFILE_SCOPE,
    OPENSHELL_READ_SCOPE,
    OPENSHELL_SERVICE,
    openShellSource,
    policyDigest,
    policyFacts,
    policyIsLoaded,
    profileBindsCredential,
    sandboxIdOf,
    verdictsFor,
} from '../../../packages/agent-harness-scanner/src/sources/openshell';
import { SourceReadError, type SourceContext, type SourceRead } from '../../../packages/agent-harness-scanner/src/source';
import {
    isDeclaredGatewayCall,
    SCANNER_SURFACE,
    SCANNER_VERSION,
    scannerManifestHash,
} from '../../../packages/agent-harness-scanner/src/scanner-surface';
import type { OpenShellReadWire, OpenShellTarget } from '../../../packages/agent-harness-scanner/src/http';

const ASOF = new Date('2026-10-24T09:00:00.000Z');
const TARGET: OpenShellTarget = { url: 'https://gateway.acme.example', headers: { authorization: 'Bearer fake-read-token-3936' } };

/** Strings the fake puts in members the source must never keep. */
const MARKERS = {
    host: 'MARKER-HOST-api.secret-internal.example',
    rule: 'MARKER-L7-RULE-/admin/keys',
    binary: 'MARKER-BINARY-/usr/local/bin/exfil',
    fsPath: 'MARKER-FS-/var/secrets',
    runAs: 'MARKER-RUNAS-root',
    middleware: 'MARKER-MIDDLEWARE-redactor',
    credKey: 'MARKER-CREDENTIAL-KEY-ANTHROPIC_API_KEY',
    /** The secret VALUE the `Provider` message can carry. Must never appear anywhere. */
    credValue: 'MARKER-SECRET-VALUE-sk-ant-never-reported',
} as const;

function policy(opts: { enforcement?: unknown; landlock?: string; endpoints?: number; hostless?: boolean } = {}): unknown {
    const n = opts.endpoints ?? 1;
    return {
        version: 1,
        filesystem: { read_only: [MARKERS.fsPath], read_write: ['/tmp'] },
        landlock: { compatibility: opts.landlock ?? 'hard_requirement' },
        process: { run_as_user: MARKERS.runAs, run_as_group: MARKERS.runAs },
        network_middlewares: { redact: { name: MARKERS.middleware, middleware: 'openshell/regex', on_error: 'fail_closed' } },
        network_policies: {
            vendor: {
                name: 'vendor',
                endpoints: Array.from({ length: n }, () => ({
                    ...(opts.hostless === true ? {} : { host: MARKERS.host }),
                    port: 443,
                    protocol: 'rest',
                    ...(opts.enforcement === undefined ? {} : { enforcement: opts.enforcement }),
                    rules: [{ allow: { method: 'GET', path: MARKERS.rule } }],
                })),
                binaries: [{ path: MARKERS.binary }],
            },
        },
    };
}

interface FakeGateway {
    readonly wire: OpenShellReadWire;
    /** Every method the source called, in order. */
    readonly calls: string[];
}

function gateway(opts: {
    sandboxes?: readonly unknown[][];
    policyFor?: (id: string) => unknown;
    providers?: readonly unknown[];
    profileFor?: (type: string) => unknown;
    /** What the runtime reports as loaded. Defaults to the policy's own version. */
    activeVersion?: number | null;
    failListWith?: SourceReadError;
}): FakeGateway {
    const calls: string[] = [];
    const pages = opts.sandboxes ?? [[{ id: 's-101' }, { id: 's-102' }]];
    const wire: OpenShellReadWire = {
        async listSandboxes(_t, cursor) {
            calls.push('ListSandboxes');
            if (opts.failListWith !== undefined) throw opts.failListWith;
            const i = cursor === null ? 0 : Number(cursor);
            return { sandboxes: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
        },
        async getSandbox(_t, id) {
            calls.push('GetSandbox');
            return { id, spec: { policy: (opts.policyFor ?? (() => policy()))(id) } };
        },
        async getSandboxPolicyStatus() {
            calls.push('GetSandboxPolicyStatus');
            const active = opts.activeVersion === undefined ? 1 : opts.activeVersion;
            return active === null ? {} : { active_version: active, revision: { version: active } };
        },
        async listSandboxProviders() {
            calls.push('ListSandboxProviders');
            return {
                providers:
                    opts.providers ?? [{ name: 'anthropic', type: 'claude-code', credentials: { [MARKERS.credKey]: MARKERS.credValue } }],
            };
        },
        async getProviderProfile(_t, type) {
            calls.push('GetProviderProfile');
            return (opts.profileFor ?? (() => ({ id: type, endpoints: [{ host: 'api.anthropic.com', port: 443 }] })))(type);
        },
    };
    return { wire, calls };
}

function ctxFor(g: FakeGateway): SourceContext {
    const refuse = (what: string) => () => {
        throw new Error(`the OpenShell source must not use the ${what} wire`);
    };
    return {
        asOf: ASOF,
        deadline: Number.MAX_SAFE_INTEGER,
        now: () => ASOF.getTime(),
        http: { getJson: refuse('http') as never },
        tokens: { clientCredentials: refuse('tokens') as never, jwtBearer: refuse('tokens') as never },
        mcp: { open: refuse('mcp') as never, listTools: refuse('mcp') as never },
        register: { read: refuse('register') as never },
        openshell: g.wire,
    };
}

const read = (g: FakeGateway): Promise<SourceRead> => openShellSource({ target: TARGET }).read(ctxFor(g));
/** The same source with the estate opted in to reading providers. */
const readWithProviders = (g: FakeGateway): Promise<SourceRead> =>
    openShellSource({ target: TARGET, readProviders: true }).read(ctxFor(g));

describe('1. one agent per sandbox, pointers not content', () => {
    it('reports each sandbox as one agent, and by default reads NO providers', async () => {
        const g = gateway({});
        const result = await read(g);
        expect(result).toMatchObject({ kind: 'runtime', status: 'COMPLETE', rows: 2 });
        expect(result.observations.map((o) => o.discoveredId)).toEqual(['openshell:sandbox:s-101', 'openshell:sandbox:s-102']);
        // 1.1b: the provider listing is secret-bearing in shape, so it is not
        // read unless the estate opts in. By the call log, not just the output.
        expect(result.observations[0].credentials).toEqual([]);
        expect(g.calls).not.toContain('ListSandboxProviders');
        expect(g.calls).not.toContain('GetProviderProfile');
        // A label in the estate is something its administrator could write.
        expect(result.observations[0].owner).toBeNull();
    });

    it('with the opt-in on, names each provider by reference and reads its profile', async () => {
        const g = gateway({});
        const result = await readWithProviders(g);
        expect(result.observations[0].credentials).toEqual([
            { ref: 'openshell://sandbox/s-101/provider/anthropic', ageDays: null, expires: null, boundToAgent: true, grant: 'unknown' },
        ]);
        expect(g.calls).toContain('ListSandboxProviders');
        expect(g.calls).toContain('GetProviderProfile');
    });

    it('the secret VALUE the Provider message can carry never reaches the report, opt-in or not', async () => {
        for (const result of [await read(gateway({})), await readWithProviders(gateway({}))]) {
            expect(JSON.stringify(result)).not.toContain(MARKERS.credValue);
            expect(JSON.stringify(result)).not.toContain(MARKERS.credKey);
        }
        // The control: the fake really does serve both.
        expect(JSON.stringify({ credentials: { [MARKERS.credKey]: MARKERS.credValue } })).toContain(MARKERS.credValue);
    });

    it('keeps no policy content — every discarded member holds a marker', async () => {
        /*
            Driven over an ENFORCING policy on purpose. The digest only reaches
            the report as a MET verdict's evidence — a not-met verdict carries
            `evidence: null`, because evidence for a false verdict is not
            evidence — so a non-enforcing fixture would assert marker-absence
            over a report that contains no pointer at all. That version passed
            while proving less: it could not distinguish "content discarded"
            from "nothing reported". Here the pointer IS present and the
            content still is not.
        */
        const result = await read(gateway({ policyFor: () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }) }));
        const serialised = JSON.stringify(result);
        expect(serialised).toContain('openshell-policy:sha256:');
        /*
            The control is against EVERYTHING THE FAKE SERVED, across both
            methods — not against the policy alone. The first version checked
            the policy only, and failed on `credKey`, which the fake puts in the
            PROVIDER listing. That failure was the control working: it proved my
            marker set spans two responses, and a check against one of them
            would have silently stopped covering the other.
        */
        const served = JSON.stringify({
            policy: policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }),
            providers: [{ name: 'anthropic', type: 'claude-code', credentials: { [MARKERS.credKey]: MARKERS.credValue } }],
        });
        expect(Object.keys(MARKERS).length).toBeGreaterThanOrEqual(7);
        for (const marker of Object.values(MARKERS)) {
            expect(served).toContain(marker);
            expect(serialised).not.toContain(marker);
        }
    });

    it('the digest is a pointer that moves with the policy and carries none of it', () => {
        const a = policyDigest(policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }));
        const b = policyDigest(policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_AUDIT' }));
        // The format assertion is the strong one: a 64-hex digest cannot carry a
        // hostname, so a `not.toContain(host)` beside it is an assertion that
        // could not fail while this one holds. Left out deliberately.
        expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(a).not.toBe(b);
    });
});

describe('2. the proto zero value is not enforcement', () => {
    const CRITERIA = ['H3.egress_enforced', 'H2.tools_allowlisted'] as const;

    it('every endpoint on ENFORCE, with a host, is the only shape that is met', async () => {
        const result = await read(gateway({ policyFor: () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }) }));
        const v = result.observations[0].verdicts;
        for (const c of CRITERIA) expect(v.find((x) => x.criterion === c)).toMatchObject({ met: true });
        expect(v.find((x) => x.criterion === 'H3.egress_enforced')?.evidence).toMatch(/^openshell-policy:sha256:/);
    });

    it.each([
        ['an explicit AUDIT endpoint', 'NETWORK_ENFORCEMENT_MODE_AUDIT'],
        ['an explicit UNSPECIFIED endpoint', 'NETWORK_ENFORCEMENT_MODE_UNSPECIFIED'],
        ['the numeric audit value', 2],
        ['the numeric zero', 0],
        ['a value this reader does not recognise', 'NETWORK_ENFORCEMENT_MODE_FUTURE_THING'],
    ])('%s evidences nothing, and names no evidence', async (_label, enforcement) => {
        const result = await read(gateway({ policyFor: () => policy({ enforcement }) }));
        for (const c of CRITERIA) {
            expect(result.observations[0].verdicts.find((x) => x.criterion === c)).toMatchObject({ met: false, evidence: null });
        }
    });

    it('an ABSENT enforcement field is as fatal as an explicit audit one — the same bytes on the wire', async () => {
        const absent = await read(gateway({ policyFor: () => policy({}) }));
        const audit = await read(gateway({ policyFor: () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_AUDIT' }) }));
        expect(absent.observations[0].verdicts).toEqual(audit.observations[0].verdicts);
        expect(absent.observations[0].verdicts.every((v) => v.met === false)).toBe(true);
    });

    it('ONE audit endpoint among enforcing ones fails the whole sandbox', () => {
        const facts = policyFacts({
            network_policies: {
                a: { endpoints: [{ host: 'h', enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }] },
                b: { endpoints: [{ host: 'h', enforcement: 'NETWORK_ENFORCEMENT_MODE_AUDIT' }] },
            },
        });
        expect(facts.enforcement).toEqual(['enforce', 'audit']);
        expect(verdictsFor(facts).every((v) => v.met === false)).toBe(true);
    });

    it('a policy with NO endpoints evidences nothing — it is not vacuously enforced', () => {
        for (const empty of [{}, { network_policies: {} }, { network_policies: { a: { endpoints: [] } } }, null]) {
            const facts = policyFacts(empty);
            expect(facts.endpoints).toBe(0);
            expect(verdictsFor(facts).every((v) => v.met === false)).toBe(true);
        }
    });

    it('a hostless endpoint is not an allow-list of the agent tool hosts', async () => {
        const result = await read(
            gateway({ policyFor: () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE', hostless: true }) }),
        );
        const v = result.observations[0].verdicts;
        // Egress is enforced; the hosts are not allow-listed. The two differ.
        expect(v.find((x) => x.criterion === 'H3.egress_enforced')).toMatchObject({ met: true });
        expect(v.find((x) => x.criterion === 'H2.tools_allowlisted')).toMatchObject({ met: false, evidence: null });
    });

    it('enforcementWord maps only the three it knows, and defaults to unspecified', () => {
        expect(enforcementWord('NETWORK_ENFORCEMENT_MODE_ENFORCE')).toBe('enforce');
        expect(enforcementWord(1)).toBe('enforce');
        expect(enforcementWord('NETWORK_ENFORCEMENT_MODE_AUDIT')).toBe('audit');
        for (const odd of [undefined, null, '', 'enforce', 'ENFORCE', 7, {}, []]) expect(enforcementWord(odd)).toBe('unspecified');
    });
});

describe('3. best-effort landlock is not confinement, and raises nothing either way', () => {
    it.each(['best_effort', '', 'hard_requirement', 'something_else'])(
        'compatibility %p raises no filesystem criterion',
        (compatibility) => {
            const facts = policyFacts({ landlock: { compatibility }, network_policies: {} });
            expect(facts.landlock).toBe(compatibility);
            const criteria = verdictsFor(facts).map((v) => v.criterion);
            expect(criteria).toEqual(['H3.egress_enforced', 'H2.tools_allowlisted', 'H3.payloads_guarded', 'H2.credential_bound']);
            expect(criteria.some((c) => /filesystem|confine|landlock/i.test(c))).toBe(false);
        },
    );

    it('an unset landlock reads as empty, never as hard_requirement', () => {
        expect(policyFacts({}).landlock).toBe('');
        expect(policyFacts({ landlock: {} }).landlock).toBe('');
        expect(policyFacts({ landlock: 'hard_requirement' }).landlock).toBe('');
    });
});

describe('4. read-only, by the call log', () => {
    it('calls only declared read methods, and never a mutation', async () => {
        const g = gateway({});
        await read(g);
        expect(g.calls.length).toBeGreaterThan(0);
        for (const method of g.calls) expect(OPENSHELL_METHODS as readonly string[]).toContain(method);
        for (const forbidden of ['CreateSandbox', 'DeleteSandbox', 'ExecSandbox', 'StopSandbox', 'AttachSandboxProvider']) {
            expect(g.calls).not.toContain(forbidden);
        }
    });

    it('touches no other wire — http, tokens, mcp and register all throw if used', async () => {
        // ctxFor wires each of the four to throw, so this passing means the
        // source reached none of them.
        await expect(read(gateway({}))).resolves.toMatchObject({ status: 'COMPLETE' });
    });

    it('declares one service, five read-shaped methods, and two scopes kept apart', () => {
        expect(OPENSHELL_SERVICE).toBe('openshell.v1.OpenShell');
        expect([...OPENSHELL_METHODS]).toEqual([
            'ListSandboxes',
            'GetSandbox',
            'GetSandboxPolicyStatus',
            'ListSandboxProviders',
            'GetProviderProfile',
        ]);
        // Every method reads. There is no verb here that could change anything.
        for (const m of OPENSHELL_METHODS) expect(m).toMatch(/^(List|Get)/);
        expect(OPENSHELL_READ_SCOPE).toBe('sandbox:read');
        expect(OPENSHELL_PROFILE_SCOPE).toBe('provider:read');
        // Kept apart so a default scan asks for one, and the widening shows in
        // configuration rather than being implied by the method list.
        expect(OPENSHELL_READ_SCOPE).not.toBe(OPENSHELL_PROFILE_SCOPE);
    });
});

describe('4b. the declared surface, and what it refuses', () => {
    it('declares the one service and exactly the five read RPCs', () => {
        const entry = SCANNER_SURFACE.readsGateway.find((r) => r.product === 'openshell');
        expect(entry).toBeDefined();
        expect(entry?.service).toBe('openshell.v1.OpenShell');
        expect([...(entry?.rpcs ?? [])]).toEqual([...OPENSHELL_METHODS]);
        expect([...(entry?.scopes ?? [])]).toEqual(['sandbox:read', 'provider:read']);
        // The kind on the wire is the existing `runtime`, not a new one (D1).
        expect(entry?.source).toBe('runtime');
    });

    it('accepts every declared RPC and refuses every mutation on the same service', () => {
        for (const rpc of OPENSHELL_METHODS) {
            expect(isDeclaredGatewayCall(`/openshell.v1.OpenShell/${rpc}`)).toBe(true);
        }
        // These are siblings on the SAME service — the reason the list is
        // declared rather than inferred from the host.
        for (const rpc of [
            'CreateSandbox',
            'DeleteSandbox',
            'ExecSandbox',
            'StopSandbox',
            'AttachSandboxProvider',
            'DetachSandboxProvider',
            'CreateSshSession',
            'SetSandboxPolicy',
        ]) {
            expect(isDeclaredGatewayCall(`/openshell.v1.OpenShell/${rpc}`)).toBe(false);
        }
    });

    it('refuses another service, a malformed path, and the compute-driver service', () => {
        for (const path of [
            '/openshell.v1.Other/ListSandboxes',
            '/openshell.compute.v1.ComputeDriver/ListSandboxes',
            '/ListSandboxes',
            '/openshell.v1.OpenShell/ListSandboxes/extra',
            '/openshell.v1.OpenShell/',
            '',
        ]) {
            expect(isDeclaredGatewayCall(path)).toBe(false);
        }
    });

    it('the manifest hash covers the gateway surface, so widening it cannot ship quietly', () => {
        const before = scannerManifestHash();
        expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);
        // The surface is frozen `as const`, so this asserts the property by
        // construction: the hash is over canonical JSON of the whole object,
        // and `readsGateway` is in it.
        expect(JSON.stringify(SCANNER_SURFACE)).toContain('openshell.v1.OpenShell');
        expect(SCANNER_VERSION).toBe('0.10.0');
    });
});

describe('5. a read that stopped is INCOMPLETE with a reason, never complete-and-empty', () => {
    it.each([
        ['a timed-out gateway', new SourceReadError('TIME_BOX', 'the gateway did not answer in time'), 'TIME_BOX'],
        ['a rate-limited gateway', new SourceReadError('RATE_LIMITED', 'the gateway rate-limited the reader'), 'RATE_LIMITED'],
        ['a refused gateway', new SourceReadError('UNREACHABLE', 'the gateway refused the connection'), 'UNREACHABLE'],
    ])('%s is INCOMPLETE with its own reason', async (_label, err, reason) => {
        const result = await read(gateway({ failListWith: err as SourceReadError }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason, observations: [] });
    });

    it('a fault in the reader is still INCOMPLETE, as UNREACHABLE — the reason that claims least', async () => {
        const g = gateway({});
        const broken: FakeGateway = {
            calls: g.calls,
            wire: { ...g.wire, getSandbox: async () => { throw new TypeError('a bug in the reader'); } },
        };
        expect(await read(broken)).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
    });

    it('a listing that serves one sandbox twice is PAGINATION_TORN, and keeps what it read', async () => {
        const result = await read(gateway({ sandboxes: [[{ id: 's-1' }], [{ id: 's-1' }]] }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(result.observations.map((o) => o.discoveredId)).toEqual(['openshell:sandbox:s-1']);
    });

    it('a row without a plain id is counted and reported as nothing', async () => {
        const result = await read(gateway({ sandboxes: [[{ id: 's-1' }, { id: 'not a plain id!' }, {}, null]] }));
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 4 });
        expect(result.observations).toHaveLength(1);
    });

    it('caps the listing rather than following it forever', () => {
        expect(MAX_SANDBOXES).toBeGreaterThan(0);
        expect(MAX_SANDBOXES).toBeLessThanOrEqual(10_000);
    });
});

describe('7. a policy in a drawer is not a policy in force', () => {
    const met = (r: SourceRead, c: string) => r.observations[0].verdicts.find((v) => v.criterion === c)?.met;

    it('a declared policy the runtime has NOT loaded evidences nothing', async () => {
        const enforcing = () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' });
        // Same policy, same enforcement, differing only in what is loaded.
        const inForce = await read(gateway({ policyFor: enforcing, activeVersion: 1 }));
        const drawer = await read(gateway({ policyFor: enforcing, activeVersion: 2 }));
        expect(met(inForce, 'H3.egress_enforced')).toBe(true);
        expect(met(drawer, 'H3.egress_enforced')).toBe(false);
        expect(drawer.observations[0].verdicts.every((v) => v.met === false)).toBe(true);
    });

    it('a status that could not be read is not evidence that it is loaded', async () => {
        const result = await read(gateway({ policyFor: () => policy({ enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE' }), activeVersion: null }));
        expect(result.observations[0].verdicts.every((v) => v.met === false)).toBe(true);
    });

    it('policyIsLoaded requires a matching integer on both sides', () => {
        expect(policyIsLoaded({ active_version: 3 }, 3)).toBe(true);
        for (const [status, declared] of [
            [{ active_version: 2 }, 3],
            [{}, 3],
            [{ active_version: '3' }, 3],
            [{ active_version: 3.5 }, 3],
            [null, 3],
            [{ active_version: 3 }, null],
        ] as const) {
            expect(policyIsLoaded(status, declared as number | null)).toBe(false);
        }
    });
});

describe('8. payloads_guarded needs a stage that both selects and fails closed', () => {
    const guarded = (mw: unknown): boolean =>
        policyFacts({ version: 1, network_middlewares: mw === null ? undefined : { a: mw } }).payloadsInspected;

    it('a fail-closed stage over named hosts inspects payloads', () => {
        expect(guarded({ middleware: 'openshell/regex', on_error: 'fail_closed', endpoints: { include: ['api.vendor.example'] } })).toBe(true);
    });

    it.each([
        ['fail_open', { middleware: 'm', on_error: 'fail_open', endpoints: { include: ['h'] } }],
        ['an absent on_error, whose documented default is fail_closed', { middleware: 'm', endpoints: { include: ['h'] } }],
        ['an empty include — it selects nothing', { middleware: 'm', on_error: 'fail_closed', endpoints: { include: [] } }],
        ['no selector at all', { middleware: 'm', on_error: 'fail_closed' }],
        ['no middleware configured', null],
    ])('%s does not', (_label, mw) => {
        expect(guarded(mw)).toBe(false);
    });

    it('the absent on_error case is deliberate, not an oversight', () => {
        /*
            `on_error` documents fail_closed as its default, so an absent value
            is probably safe — the OPPOSITE of `enforcement`, where the zero
            value is permissive. It is still required affirmatively. One rule
            applied uniformly beats a reading whose safety depends on which
            field's default happens to point the right way, and a documented
            default is not an observed one: 0.1b found a documented default
            that WAS implemented, which is evidence about one field, not a
            licence to trust the next.
        */
        expect(guarded({ middleware: 'm', on_error: '', endpoints: { include: ['h'] } })).toBe(false);
    });
});

describe('9. credential_bound comes from the profile, and only with the opt-in', () => {
    const bound = (r: SourceRead) => r.observations[0].verdicts.find((v) => v.criterion === 'H2.credential_bound')?.met;

    it('is unevidenced without the opt-in, because there is no profile to read', async () => {
        expect(bound(await read(gateway({})))).toBe(false);
    });

    it('is met when every attached provider profile names a host', async () => {
        expect(bound(await readWithProviders(gateway({})))).toBe(true);
    });

    it.each([
        ['a profile with no endpoints', { id: 'p', endpoints: [] }],
        ['a profile with a hostless endpoint', { id: 'p', endpoints: [{ port: 443 }] }],
        ['a profile with one hostless among hosts', { id: 'p', endpoints: [{ host: 'h' }, { port: 443 }] }],
        ['no profile at all', null],
    ])('%s does not bind the credential', async (_label, profile) => {
        expect(bound(await readWithProviders(gateway({ profileFor: () => profile })))).toBe(false);
    });

    it('one unscoped provider among scoped ones fails the sandbox', async () => {
        const g = gateway({
            providers: [{ name: 'a', type: 'scoped' }, { name: 'b', type: 'unscoped' }],
            profileFor: (type) => (type === 'scoped' ? { endpoints: [{ host: 'h' }] } : { endpoints: [] }),
        });
        expect(bound(await readWithProviders(g))).toBe(false);
    });

    it('a provider without a plain type is not silently treated as bound', async () => {
        const g = gateway({ providers: [{ name: 'a' }] });
        expect(bound(await readWithProviders(g))).toBe(false);
    });

    it('profileBindsCredential, driven directly', () => {
        expect(profileBindsCredential({ endpoints: [{ host: 'h' }] })).toBe(true);
        for (const bad of [null, {}, { endpoints: [] }, { endpoints: [{ port: 1 }] }, { endpoints: 'x' }]) {
            expect(profileBindsCredential(bad)).toBe(false);
        }
    });
});

describe('6. the small readers, driven directly', () => {
    it('sandboxIdOf takes a plain id from either member and refuses anything else', () => {
        expect(sandboxIdOf({ id: 's-1' })).toBe('s-1');
        expect(sandboxIdOf({ sandbox_id: 's-2' })).toBe('s-2');
        for (const bad of [null, {}, { id: '' }, { id: 'has space' }, { id: 'a'.repeat(129) }, 'str']) {
            expect(sandboxIdOf(bad)).toBeNull();
        }
    });

    it('credentialOf names a provider by reference and refuses a nameless one', () => {
        expect(credentialOf({ name: 'anthropic' }, 's-1')?.ref).toBe('openshell://sandbox/s-1/provider/anthropic');
        for (const bad of [null, {}, { name: '' }, { name: 'not plain!' }]) expect(credentialOf(bad, 's-1')).toBeNull();
    });
});
