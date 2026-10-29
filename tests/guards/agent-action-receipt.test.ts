/**
 * Ratchet — agent-action receipts (pipelock CORE, Apache-2.0).
 *
 * Locks the load-bearing invariants:
 *   1. SIGNATURE GATE — a correctly-signed receipt verifies and links to a
 *      hash-chained AuditLog entry; a TAMPERED or absent-signature receipt is
 *      rejected/flagged and does NOT link to an AuditLog entry.
 *   2. scannedSummary is size-capped and contains no credential/PII (a planted
 *      secret is redacted; an oversize blob is dropped to a marker).
 *   3. AgentActionReceipt carries the two tenantId-leading indexes; the verify
 *      path writes through the usecase / runInTenantContext (no global-`prisma`
 *      write).
 *   4. LICENSE — no phantom pipelock/fleet npm dependency; NOTICE credits the
 *      Apache-2.0 CORE; the verifier documents the Apache-core boundary.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { codeOf, interfaceBodyOf } from '../helpers/source-blocks';
import { collectorSandboxPolicy } from '@/lib/agentic/openshell/collector-policy';
import {
    generateKeyPairSync,
    sign as cryptoSign,
    createHash,
} from 'crypto';

import {
    canonicalizeActionRecord,
    receiptSignedMessage,
    verifyReceiptSignature,
    boundAndScrubSummary,
    SCANNED_SUMMARY_MAX_BYTES,
    PipelockReceiptSchema,
    type PipelockReceipt,
} from '@/lib/mcp/receipt-verification';

const REPO_ROOT = join(__dirname, '..', '..');

// ── In-test Ed25519 keypair + signer (mirrors pipelock's signer) ────────────

function makeKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Raw 32-byte public key = last 32 bytes of the SPKI DER encoding.
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubHex, privateKey };
}

function signReceipt(
    actionRecord: Record<string, unknown>,
    key: ReturnType<typeof makeKeypair>,
): PipelockReceipt {
    const message = receiptSignedMessage(actionRecord);
    const sig = cryptoSign(null, message, key.privateKey);
    return {
        action_record: actionRecord,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: key.pubHex,
    };
}

const SAMPLE_RECORD = {
    tool: 'list_controls',
    verdict: 'allow',
    policy: 'balanced-v1',
    timestamp: '2026-07-03T10:00:00.000Z',
    agent_id: 'agent-42',
    scanned: { target: 'api.anthropic.com', bytes: 1024 },
};

// ── Mocked module boundaries for the ingestReceipt integration ───────────────

interface CapturedCreate {
    data: Record<string, unknown>;
}
const mockCaptured: CapturedCreate[] = [];
const mockEnv: { PIPELOCK_PUBLIC_KEY?: string; PIPELOCK_STRICT_MODE?: string } = {};
const mockAppend = jest.fn(() => Promise.resolve({ id: 'audit-1', entryHash: 'h', previousHash: null }));

jest.mock('@/env', () => ({ env: mockEnv }));
jest.mock('@/lib/observability', () => ({ log: jest.fn() }));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: (...args: unknown[]) => mockAppend(...(args as [])) }));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            agentActionReceipt: {
                create: (args: CapturedCreate) => {
                    mockCaptured.push(args);
                    return Promise.resolve({ id: 'receipt-1' });
                },
                findMany: () => Promise.resolve([]),
                findFirst: () => Promise.resolve(null),
            },
            // The tool-manifest pin the ingest path stamps onto every receipt.
            // `null` — nothing pinned — keeps this suite about the signature
            // gate; the provenance stamp is proved in
            // tests/integration/agent-receipt-tool-provenance.test.ts.
            mcpToolManifestPin: { findUnique: () => Promise.resolve(null) },
        }),
}));

// Imported AFTER the mocks are registered.
import { ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    mockCaptured.length = 0;
    mockAppend.mockClear();
});

// ── 1. Signature gate (pure verify) ─────────────────────────────────────────

describe('signature verification', () => {
    it('accepts a correctly-signed receipt', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        const res = verifyReceiptSignature(receipt, key.pubHex);
        expect(res.valid).toBe(true);
        expect(res.signingKeyId).toBe(key.pubHex);
    });

    it('rejects a receipt whose action_record was tampered after signing', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        // Mutate a signed field — the signature no longer matches.
        const tampered: PipelockReceipt = {
            ...receipt,
            action_record: { ...receipt.action_record, verdict: 'block' },
        };
        const res = verifyReceiptSignature(tampered, key.pubHex);
        expect(res.valid).toBe(false);
        expect(res.reason).toBe('signature_invalid');
    });

    it('rejects when no public key is configured (fail closed)', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        expect(verifyReceiptSignature(receipt, undefined).valid).toBe(false);
        expect(verifyReceiptSignature(receipt, '').reason).toBe('no_configured_key');
    });

    it('rejects a receipt signed by a different key (signer mismatch / wrong key)', () => {
        const key = makeKeypair();
        const other = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        // Configured key belongs to a different keypair.
        const res = verifyReceiptSignature(receipt, other.pubHex);
        expect(res.valid).toBe(false);
    });

    it('canonicalization is deterministic + key-order independent', () => {
        const a = canonicalizeActionRecord({ b: 1, a: 2, nested: { y: 1, x: 2 } });
        const b = canonicalizeActionRecord({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
        expect(a).toBe(b);
        // The signed message is the SHA-256 of that canonical form.
        expect(receiptSignedMessage({ a: 1 })).toEqual(
            createHash('sha256').update(canonicalizeActionRecord({ a: 1 })).digest(),
        );
    });
});

// ── 1b. Signature gate through ingestReceipt (audit-link behaviour) ──────────

describe('ingestReceipt audit linkage', () => {
    it('verified receipt → writes an AuditLog entry and links it', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);

        const result = await ingestReceipt(makeRequestContext('ADMIN'), receipt);

        expect(result.verified).toBe(true);
        expect(result.auditLogId).toBe('audit-1');
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockCaptured).toHaveLength(1);
        expect(mockCaptured[0].data.verified).toBe(true);
        expect(mockCaptured[0].data.auditLogId).toBe('audit-1');
    });

    it('tampered receipt → NO AuditLog entry, persisted flagged + unlinked', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        const tampered: PipelockReceipt = {
            ...receipt,
            action_record: { ...receipt.action_record, verdict: 'block' },
        };

        const result = await ingestReceipt(makeRequestContext('ADMIN'), tampered);

        expect(result.verified).toBe(false);
        expect(result.auditLogId).toBeNull();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockCaptured[0].data.verified).toBe(false);
        expect(mockCaptured[0].data.auditLogId).toBeNull();
    });

    it('absent signature → rejected at parse (never linked)', async () => {
        mockEnv.PIPELOCK_PUBLIC_KEY = makeKeypair().pubHex;
        const noSig = { action_record: { ...SAMPLE_RECORD }, signer_key: 'abcd' };
        await expect(ingestReceipt(makeRequestContext('ADMIN'), noSig)).rejects.toThrow();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(PipelockReceiptSchema.safeParse(noSig).success).toBe(false);
    });
});

// ── 2. scannedSummary bounding + scrubbing ──────────────────────────────────

describe('scannedSummary scrubbing', () => {
    it('redacts planted credential/PII field names', () => {
        const out = boundAndScrubSummary({
            tool: 'run',
            apiKey: 'iflk_supersecretvalue',  // pragma: allowlist secret -- synthetic test input, not a real secret
            password: 'hunter2',
            authorization: 'Bearer xyz',
            safe: 'ok',
        });
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('iflk_supersecretvalue');  // pragma: allowlist secret -- synthetic test input, not a real secret
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('Bearer xyz');
        expect(out.safe).toBe('ok');
    });

    it('summarizes a large blob string so no raw payload leaks', () => {
        const big = { blob: 'A'.repeat(SCANNED_SUMMARY_MAX_BYTES + 1000) };
        const out = boundAndScrubSummary(big);
        expect(JSON.stringify(out)).not.toContain('AAAAAAAAAA');
    });

    it('caps a summary that stays oversize after scrubbing (drops to a marker)', () => {
        // Many small fields that survive redaction but sum past the byte cap.
        const many: Record<string, string> = {};
        for (let i = 0; i < 500; i++) many[`field_${i}`] = `value-${i}-padding-xxxxxxxxxxxxxxxx`;
        const out = boundAndScrubSummary(many);
        expect(out._capped).toBe(true);
        expect(JSON.stringify(out)).not.toContain('value-0-padding');
    });

    it('planted secret is scrubbed on the ingest write path', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt(
            { tool: 'run', verdict: 'allow', secret: 'iflk_LEAK', timestamp: '2026-07-03T10:00:00.000Z' },  // pragma: allowlist secret -- synthetic test input, not a real secret
            key,
        );
        await ingestReceipt(makeRequestContext('ADMIN'), receipt);
        expect(JSON.stringify(mockCaptured[0].data.scannedSummary)).not.toContain('iflk_LEAK');  // pragma: allowlist secret -- synthetic test input, not a real secret
    });
});

// ── 3. Structural — indexes + no direct prisma in verify path ───────────────

describe('structural guarantees', () => {
    const automation = readFileSync(join(REPO_ROOT, 'prisma/schema/automation.prisma'), 'utf8');
    const usecase = readFileSync(join(REPO_ROOT, 'src/app-layer/usecases/agent-action-receipt.ts'), 'utf8');

    it('AgentActionReceipt carries the two tenantId-leading indexes', () => {
        const model = automation.slice(automation.indexOf('model AgentActionReceipt'));
        expect(model).toMatch(/@@index\(\[tenantId, occurredAt\]\)/);
        expect(model).toMatch(/@@index\(\[tenantId, mcpKeyId\]\)/);
    });

    it('verify path writes via runInTenantContext, never global prisma', () => {
        expect(usecase).toMatch(/runInTenantContext/);
        // No global-`prisma` client write in the usecase (must go through the tx db).
        expect(usecase).not.toMatch(/\bprisma\.agentActionReceipt/);
    });
});

// ── 4. License boundary ─────────────────────────────────────────────────────

describe('pipelock license boundary', () => {
    it('no phantom pipelock/fleet npm dependency', () => {
        const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const name of Object.keys(all)) {
            expect(name).not.toMatch(/pipelock|fleet-receipt/i);
        }
    });

    it('NOTICE credits pipelock Apache-2.0 core', () => {
        const notice = readFileSync(join(REPO_ROOT, 'NOTICE'), 'utf8');
        expect(notice).toMatch(/pipelock/i);
        expect(notice).toMatch(/Apache-2\.0|Apache License/i);
    });

    it('verifier documents the Apache-core boundary', () => {
        const mod = readFileSync(join(REPO_ROOT, 'src/lib/mcp/receipt-verification.ts'), 'utf8');
        expect(mod).toMatch(/Apache-2\.0/);
        expect(mod).toMatch(/CORE/);
    });
});

/**
 * D4, the split by role — 4.5 (#3967).
 *
 * pipelock mediates MCP and signs the receipts behind `H4.receipts`; OpenShell
 * confines execution and NON-MCP egress and signs nothing. The issue states the
 * consequence plainly: OpenShell's policies contain no MCP rules, which also
 * sidesteps NVIDIA/OpenShell#4679 and the prover's blindness to MCP rules.
 *
 * Asserted here rather than in a new guard file because the property is about
 * the same boundary the block above defends, from the other side: that one keeps
 * the Elastic-licensed half out, this one keeps the two mediators from
 * overlapping.
 *
 * Read through parsed exports and comment-masked source, never raw text. A
 * guard that greps raw source for "mcp" would be satisfied by a docblock
 * mentioning MCP and would fail on one explaining why MCP is absent — which is
 * exactly the prose this module is full of.
 */
describe('D4 — OpenShell carries no MCP rules, pipelock stays the only mediator', () => {
    const openShellDir = join(REPO_ROOT, 'src/lib/agentic/openshell');

    /**
     * Enumerated as CONSTANT paths rather than walked, for two reasons that
     * agree.
     *
     * `assertion-needle-uniqueness`'s Class D counts a `readFileSync` whose path
     * is built in a loop as un-analysable — "build the path in a loop and the
     * ratchet stops seeing it" — and my first version pushed that baseline from
     * 1386 to 1388. A constant path is one the analyser follows.
     *
     * And it is the stronger shape anyway: the completeness assertion below
     * makes a NEW module in this directory fail HERE until somebody adds it,
     * which is what a walk cannot do — a walk covers a new file silently, so
     * nobody reads the rule when the file arrives. Same trade
     * `ALLOWED_EXECUTORS` makes in `tool-execution-is-bounded`.
     */
    const OPENSHELL_MODULES = [
        'src/lib/agentic/openshell/collector-policy.ts',
        'src/lib/agentic/openshell/executor.ts',
        // Added by 5.4 (#3974). The third module this enumeration has caught
        // rather than review — see the note below.
        'src/lib/agentic/openshell/kill-drill.ts',
        // Added by 5.2 (#4403) while this PR was open, and caught by the
        // completeness test below rather than by review. That is the test
        // earning its place: each PR was green alone, and the fourth module
        // only became uncovered once both were on main.
        'src/lib/agentic/openshell/policy-drift.ts',
        'src/lib/agentic/openshell/transport.ts',
    ] as const;

    it('the enumeration covers every module in the directory', () => {
        // The half a constant list cannot give itself. A module added here and
        // not listed above fails this, rather than going unchecked.
        const onDisk = readdirSync(openShellDir)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => `src/lib/agentic/openshell/${f}`)
            .sort();
        expect(onDisk).toEqual([...OPENSHELL_MODULES].sort());
    });

    /*
        ASSERTED BEHAVIOURALLY, not by reading source — and that took three
        attempts to get right, which is worth recording because the reason is a
        genuine tension between two of this repo's own ratchets.

        A negative whole-file assertion (`not.toMatch(/mcp/)`) MUST mask
        comments, or a docblock explaining why MCP is absent fails it — this
        directory's docblocks discuss MCP for exactly that reason. Masking means
        `codeOf(readFileSync(...))`, and Class D of
        `assertion-needle-uniqueness` counts a transformed read as
        un-analysable: its `content-transformed` bucket. So Class A requires the
        masking that Class D penalises, and the baseline moved 1386 -> 1388 ->
        1390 -> 1391 across my attempts at constant paths and `it.each`.

        The way out is not a cleverer read. It is to stop asserting on text: what
        the split actually claims is that an OpenShell module does not REACH an
        MCP surface, and a module's reach is observable by importing it and
        looking at what came with it. No file read, no needle, nothing for
        either ratchet to object to — and it catches a transitive import that no
        source scan of these three files ever would.
    */
    it('importing the OpenShell modules pulls in no MCP module', async () => {
        jest.resetModules();
        await import('@/lib/agentic/openshell/transport');
        await import('@/lib/agentic/openshell/executor');
        await import('@/lib/agentic/openshell/collector-policy');
        await import('@/lib/agentic/openshell/policy-drift');
        await import('@/lib/agentic/openshell/kill-drill');

        const loaded = Object.keys(require.cache);
        // Non-vacuous: the modules themselves must be in there, or an empty
        // cache would pass this trivially.
        expect(loaded.some((m) => m.includes('agentic/openshell/transport'))).toBe(true);

        const mcp = loaded.filter((m) => /[\\/]lib[\\/]mcp[\\/]/.test(m));
        expect(mcp).toEqual([]);
    });

    it('the collector policy allows cloud APIs and no MCP endpoint', () => {
        // Read as PARSED endpoints, so a comment naming an MCP host cannot
        // satisfy it and a host list that genuinely grew cannot hide in prose.
        for (const benchmark of [
            'aws_compliance.benchmark.soc_2',
            'azure_compliance.benchmark.soc_2',
            'gcp_compliance.benchmark.cis_v300',
        ]) {
            const hosts = collectorSandboxPolicy(benchmark).networkPolicies.map((e) => e.host);
            expect(hosts.length).toBeGreaterThan(0);
            for (const host of hosts) {
                expect(host).not.toMatch(/mcp/i);
                // A sandbox reaching pipelock directly would make it the
                // mediator's client rather than its subject.
                expect(host).not.toMatch(/pipelock/i);
            }
        }
    });

    it('the detector can fire — the control', () => {
        // Without this the two assertions above are satisfied by a regex that
        // matches nothing in any input.
        const planted = codeOf("import { x } from '@/lib/mcp/authorize';\nconst mcp = x;");
        expect(/\bmcp\b|@\/lib\/mcp/i.test(planted)).toBe(true);
        expect([{ host: 'mcp.internal' }].some((e) => /mcp/i.test(e.host))).toBe(true);
    });
});

/**
 * 4.3 (#3964) — the gateway deploys to its OWN host, outside the canonical
 * compose, and Watchtower does not update it.
 *
 * ═══ ASSERTED AS STRUCTURE, NOT AS TEXT ═══
 *
 * The compose file is parsed with `js-yaml` and the unit file into sections and
 * keys, for the reason #4312 recorded: the first version of that guard matched
 * `--runInBand` anywhere in the file, so a mention in a COMMENT satisfied it
 * and deleting the real flag left it green. A deployment artifact is mostly
 * commentary — this one is deliberately so — which makes a text scan the wrong
 * instrument twice over.
 *
 * ═══ THE PREMISE THAT CAN EXPIRE ═══
 *
 * "Watchtower does not update the gateway" currently rests on two independent
 * facts, and only one of them is about the gateway:
 *
 *   1. Watchtower runs on the APP VM, watching that VM's Docker socket, and
 *      has no view of the gateway host.
 *   2. It is OPT-IN: `--label-enable` plus `WATCHTOWER_LABEL_ENABLE: "true"`,
 *      so only containers labelled `…watchtower.enable=true` are candidates.
 *
 * Fact 2 is a configuration anybody can change, and dropping `--label-enable`
 * silently converts Watchtower to watching everything it can see. That would
 * not reach this gateway today, so nothing would break — which is exactly why
 * it is worth pinning. A safety argument whose premises have gone false while
 * nothing failed is worse than no argument, because it still reads as true.
 */
describe('4.3 — the gateway deploys outside the canonical compose (#3964)', () => {
    const CANONICAL = join(__dirname, '../../deploy/docker-compose.prod.yml');
    const UNIT = join(__dirname, '../../deploy/openshell/openshell-gateway.service');

    const compose = yaml.load(readFileSync(CANONICAL, 'utf8')) as {
        services?: Record<string, { image?: string; command?: string | string[];
            environment?: Record<string, string>; labels?: Record<string, string> }>;
    };

    /** The unit as section -> key -> every value, because keys repeat. */
    const unit = ((): Record<string, Record<string, string[]>> => {
        const out: Record<string, Record<string, string[]>> = {};
        let section = '';
        for (const raw of readFileSync(UNIT, 'utf8').split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith(';')) continue;
            const sec = /^\[(.+)\]$/.exec(line);
            if (sec) { section = sec[1]; out[section] ??= {}; continue; }
            const kv = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
            if (!kv || !section) continue;
            (out[section][kv[1]] ??= []).push(kv[2]);
        }
        return out;
    })();

    it('the canonical compose defines no gateway service', () => {
        // `deploy/apply.sh` pushes this file and refuses any other basename.
        // The pipelock lesson is that a service which cannot start does not
        // belong here; this one cannot even run on this HOST.
        const names = Object.keys(compose.services ?? {});
        expect(names.length).toBeGreaterThan(5);
        expect(names.filter((n) => /openshell|gateway/i.test(n))).toEqual([]);
        const images = Object.values(compose.services ?? {}).map((s) => s.image ?? '');
        expect(images.filter((i) => i.includes('openshell'))).toEqual([]);
    });

    it('apply.sh cannot push the gateway artifacts to the production VM', () => {
        // The REAL mechanism behind "outside the canonical compose", and a
        // stronger statement than the compose file merely not naming a gateway:
        // `apply.sh` pushes exactly CANONICAL_SET plus the host-config set, and
        // refuses any compose basename but `docker-compose.prod.yml`. Nothing
        // under `deploy/openshell/` is in either set, so the production VM
        // cannot acquire these files by running the deploy script.
        //
        // Asserted over the EXTRACTED ENTRIES rather than the script's text: a
        // whole-file `not.toMatch(/openshell/)` would be satisfied or broken by
        // a comment, and `deploy/apply.sh` is heavily commented.
        const apply = readFileSync(join(__dirname, '../../deploy/apply.sh'), 'utf8');
        const arrayEntries = (name: string): string[] => {
            const m = new RegExp(`${name}=\\(([^)]*)\\)`, 'm').exec(apply);
            if (!m) return [];
            return m[1]
                .split('\n')
                .map((l) => l.replace(/#.*$/, '').trim().replace(/^"|"$/g, ''))
                .filter((l) => l.length > 0);
        };
        const canonical = arrayEntries('CANONICAL_SET');
        // Non-vacuous: the array really was found and really has entries.
        expect(canonical.length).toBeGreaterThanOrEqual(3);
        expect(canonical.filter((e) => e.includes('openshell'))).toEqual([]);
        expect(arrayEntries('HOST_CONFIG_SET').filter((e) => e.includes('openshell'))).toEqual([]);
    });

    it('watchtower is still opt-in by label — the premise the exclusion rests on', () => {
        const wt = compose.services?.watchtower;
        expect(wt).toBeDefined();
        const cmd = Array.isArray(wt?.command) ? wt!.command.join(' ') : (wt?.command ?? '');
        expect(cmd).toContain('--label-enable');
        expect(wt?.environment?.WATCHTOWER_LABEL_ENABLE).toBe('true');
    });

    it('the watched set is explicit, and the gateway is not in it', () => {
        // The positive half: some services DO opt in, so "nothing is watched"
        // is not what makes the gateway safe.
        const LABEL = 'com.centurylinklabs.watchtower.enable';
        const watched = Object.entries(compose.services ?? {})
            .filter(([, s]) => s.labels?.[LABEL] === 'true')
            .map(([n]) => n);
        expect(watched.length).toBeGreaterThan(0);
        expect(watched.filter((n) => /openshell|gateway/i.test(n))).toEqual([]);
    });

    it('the unit ASSERTS its preconditions instead of CONDITIONing them', () => {
        // `Condition…` makes systemd SKIP the unit and report success, which is
        // the same silent-absence shape as pipelock's missing bind mount.
        // `Assert…` fails it and says why.
        const u = unit['Unit'] ?? {};
        expect((u['AssertPathExists'] ?? []).length).toBeGreaterThanOrEqual(3);
        expect(Object.keys(u).filter((k) => k.startsWith('Condition'))).toEqual([]);
        // And the restart limit is in [Unit], where systemd reads it.
        // `systemd-analyze verify` rejected it in [Service] as an unknown key,
        // i.e. the limit would have been silently absent.
        expect(u['StartLimitBurst']).toEqual(['3']);
        expect(unit['Service']?.['StartLimitBurst']).toBeUndefined();
    });

    it('telemetry is off and operator auth is pinned to false', () => {
        const env = (unit['Service']?.['Environment'] ?? []);
        expect(env).toContain('OPENSHELL_TELEMETRY_ENABLED=false');
        // Explicit although it is also the default, so a default that moves
        // upstream does not move this deployment.
        expect(env).toContain('OPENSHELL_ENABLE_OPERATOR_AUTH=false');
        // The gateway reads its pinned driver digests from the config, and the
        // unit must point at it or the pins are inert.
        expect(env).toContain('OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml');
    });
});

/**
 * 0.1f (#3931) — the repository depends on no OpenShell package, from anybody.
 *
 * #3931 asked whether the SDK is ESM-only, so phase 4 would know whether it
 * needs the `@flue/runtime` treatment: a jest project of its own and a boundary
 * module nothing in the main graph may import. The answer measured against the
 * registry is that there is no JavaScript SDK at all — `@nvidia/openshell-sdk`
 * is a 404, and of the 39 npm packages that mention OpenShell, none is
 * published by NVIDIA. The official SDK is Python (`pypi/openshell`,
 * `requires_python >=3.11`), which cannot enter a Node import graph under any
 * module format.
 *
 * ═══ WHY A TEST AND NOT ONLY A NOTE ═══
 *
 * Because the dangerous version of this is cheap to adopt by accident.
 * `@openkaiden/opnshll-sdk` describes itself as "Official TypeScript SDK for
 * the OpenShell gateway", is `type: module` — genuinely ESM-only, exactly as
 * #3931 feared — carries a version that mirrors the real release, and is
 * maintained by an individual. Every signal somebody would use to find "the
 * SDK" points at it. An `npm i` away, phase 4 acquires a third-party dependency
 * in the position the note says is empty.
 *
 * So the assertion is over the DEPENDENCY MANIFESTS rather than over imports: a
 * package can be depended on before anything imports it, and that is the moment
 * worth failing. It matches no allowlist of names — any dependency whose name
 * contains `openshell` or the lookalike spelling fails, whoever publishes it,
 * because adopting one is a supply-chain decision and not a module-format one.
 */
describe('0.1f — no OpenShell package is a dependency (#3931)', () => {
    const LOOKALIKE = /openshell|opnshll/i;

    const manifest = JSON.parse(
        readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as Record<string, unknown>;

    const DEP_SECTIONS = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
        'bundledDependencies',
        'bundleDependencies',
    ] as const;

    it('names none in any dependency section of package.json', () => {
        // Every section, not just `dependencies`. A devDependency is still a
        // package on the machine that builds this, and `optionalDependencies`
        // is how one arrives without failing an install.
        const named: string[] = [];
        let sectionsSeen = 0;
        for (const section of DEP_SECTIONS) {
            const deps = manifest[section];
            if (!deps) continue;
            sectionsSeen++;
            const names = Array.isArray(deps) ? deps : Object.keys(deps as object);
            for (const n of names as string[]) {
                if (LOOKALIKE.test(n)) named.push(`${section}: ${n}`);
            }
        }
        // Non-vacuous: the manifest really has dependency sections to search.
        expect(sectionsSeen).toBeGreaterThanOrEqual(2);
        expect(named).toEqual([]);
    });

    it('resolves none in the lockfile either', () => {
        // The manifest is what somebody writes; the lockfile is what actually
        // installs, including anything pulled in transitively.
        const lock = JSON.parse(
            readFileSync(join(__dirname, '../../package-lock.json'), 'utf8'),
        ) as { packages?: Record<string, unknown> };
        const paths = Object.keys(lock.packages ?? {});
        // Non-vacuous: the lockfile really was parsed and really has packages.
        expect(paths.length).toBeGreaterThan(100);
        expect(paths.filter((k) => LOOKALIKE.test(k))).toEqual([]);
    });

    it('the transport is ours — four calls we wrote, not a re-export', () => {
        // What fills the space where an SDK would sit. If this ever became a
        // re-export from a dependency, the two assertions above would be the
        // only thing standing between phase 4 and an unvetted package.
        //
        // NARROWED AND EXTRACTED, not matched against the whole file. The first
        // draft read `codeOf(src)` and asserted two `toMatch`es over it, which
        // Class D of `assertion-needle-uniqueness` counts as a transformed
        // whole-file read — +2 on a blind-spot census, and the ratchet caught
        // it. Narrowing is the documented fix and CLAUDE.md says why: a
        // narrowed read stays out of scope precisely so that taking the
        // ratchet's advice does not redden it.
        const src = readFileSync(
            join(__dirname, '../../src/lib/agentic/openshell/transport.ts'),
            'utf8',
        );

        // Bound to the interface, so the four calls are asserted where they
        // are declared rather than anywhere in a 200-line file.
        const body = interfaceBodyOf(src, 'SandboxTransport');
        expect(body.length).toBeGreaterThan(80);
        for (const call of ['createSandbox', 'execSandbox', 'deleteSandbox', 'awaitDeleted']) {
            expect(body).toContain(call);
        }

        // And the module's own specifiers, as a filtered list: nothing it pulls
        // in or re-exports may be an OpenShell package. An array comparison,
        // which carries no needle for Class D to analyse.
        const specifiers = [...codeOf(src).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
        expect(specifiers.filter((x) => LOOKALIKE.test(x))).toEqual([]);
    });

    it('the detector fires on a planted dependency — the control', () => {
        // Without this, all three assertions above are satisfied by a pattern
        // that matches nothing.
        const planted = ['@nvidia/openshell-sdk', '@openkaiden/opnshll-sdk', 'openshell-node'];
        expect(planted.filter((n) => LOOKALIKE.test(n))).toEqual(planted);
        // And it does not fire on the ordinary neighbours it sits beside.
        expect(['next', 'zod', '@flue/runtime'].filter((n) => LOOKALIKE.test(n))).toEqual([]);
    });
});
