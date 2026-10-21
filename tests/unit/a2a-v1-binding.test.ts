/**
 * THE v1.0 BINDING, CHECKED AGAINST THE PROTO (#3866).
 *
 * v1.0 ships no committed JSON Schema, so the card is held to
 * `tests/fixtures/a2a/a2a-v1.0.1.proto` — the canonical definition, vendored
 * with a blob sha that matches upstream. The requirements below are DERIVED
 * from those bytes rather than written here, so a card that drifts from the
 * spec fails even if nobody updates this file.
 *
 * The first test is the anti-blindness one, for the same reason the v0.3
 * conformance suite pins its JSON Schema keyword vocabulary: a reader that does
 * not understand a field shape omits it silently, and an omitted field passes
 * every "is it required" assertion.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { a2aSigningKeyFromSeed, mintA2aSigningSeed } from '@/lib/agentic/a2a/signing-key';
import {
    INFLECT_V1_CARD_EXTENSION_URI,
    buildInflectV1Card,
    signInflectV1Card,
} from '@/lib/agentic/a2a/own-card';
import { taskStateForRunStatus, type A2aTaskState } from '@/lib/agentic/a2a/protocol';
import {
    A2A_SUPPORTED_VERSIONS,
    A2A_VERSION_HEADER,
    V1_METHOD_ALIASES,
    V1_REFUSED_METHODS,
    V1_RELABELLED_STATES,
    resolveA2aVersion,
    resolveV1Method,
    v1TaskState,
} from '@/lib/agentic/a2a/version';
import {
    PROTO_CONSTRUCTS,
    constructsUsed,
    jsonName,
    protoEnumValues,
    protoMessages,
} from '../helpers/proto-messages';

const PROTO = readFileSync(path.resolve(__dirname, '../fixtures/a2a/a2a-v1.0.1.proto'), 'utf8');
const MESSAGES = protoMessages(PROTO);

const ORIGIN = 'https://app.inflect.test';
const NOW = new Date('2026-10-21T12:00:00Z');

const SKILLS = [
    { id: 'sap-transaction-review', name: 'Review', description: 'Reviews.', tags: ['sap'] },
] as const;

function card() {
    const k = a2aSigningKeyFromSeed(mintA2aSigningSeed());
    if (!k) throw new Error('no key');
    const unsigned = buildInflectV1Card({
        origin: ORIGIN,
        tenantSlug: 'acme',
        current: { publicKeyHex: k.publicKeyHex, fingerprint: k.fingerprint },
        previous: null,
        now: NOW,
        skills: [...SKILLS],
    });
    return { unsigned, signed: signInflectV1Card(unsigned, k), key: k };
}

/** What a client receives: JSON round-tripped, so `undefined` is gone. */
const wire = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

const requiredJsonNames = (message: string) =>
    (MESSAGES.get(message) ?? []).filter((f) => f.required).map((f) => jsonName(f.name));
const allJsonNames = (message: string) => (MESSAGES.get(message) ?? []).map((f) => jsonName(f.name));

describe('the fixture is the proto, and the reader can read it', () => {
    it('parsed the messages the card is checked against', () => {
        // A reader that found nothing would pass every assertion below
        // vacuously, so the population is asserted first.
        expect(MESSAGES.size).toBeGreaterThan(20);
        expect(MESSAGES.has('AgentCard')).toBe(true);
        expect(MESSAGES.has('AgentInterface')).toBe(true);
    });

    it('uses no field construct the reader does not understand', () => {
        // THE ANTI-BLINDNESS CHECK. A `oneof`, a group, or any shape the FIELD
        // regex misses would make that field absent from the output — where it
        // satisfies "is it required" by not existing.
        for (const message of ['AgentCard', 'AgentInterface', 'AgentCapabilities', 'AgentExtension', 'AgentSkill']) {
            const used = constructsUsed(MESSAGES.get(message) ?? []);
            const unknown = [...used].filter((c) => !(PROTO_CONSTRUCTS as readonly string[]).includes(c));
            expect({ message, unknown }).toEqual({ message, unknown: [] });
        }
    });

    it('agrees with the proto on how many fields AgentCard has', () => {
        // Pinned from the bytes: 14 fields, 8 REQUIRED. If a refreshed proto
        // changes either, this says so rather than the card silently satisfying
        // an older contract.
        expect(allJsonNames('AgentCard')).toHaveLength(14);
        expect(requiredJsonNames('AgentCard')).toEqual([
            'name',
            'description',
            'supportedInterfaces',
            'version',
            'capabilities',
            'defaultInputModes',
            'defaultOutputModes',
            'skills',
        ]);
    });
});

describe('the v1.0 card satisfies AgentCard', () => {
    it('carries every REQUIRED field, derived from the proto', () => {
        const doc = wire(card().signed);
        const missing = requiredJsonNames('AgentCard').filter((n) => doc[n] === undefined);
        expect(missing).toEqual([]);
    });

    it('carries NO field the proto does not define', () => {
        // The reason Inflect's data is in an extension rather than `x-inflect`:
        // protobuf JSON rejects unknown top-level fields, so an extra member
        // would make this card unparseable to a strict v1.0 client.
        const doc = wire(card().signed);
        const allowed = new Set(allJsonNames('AgentCard'));
        expect(Object.keys(doc).filter((k) => !allowed.has(k))).toEqual([]);
    });

    it('has no x-inflect member, unlike the v0.3 card', () => {
        const doc = wire(card().signed);
        expect(Object.keys(doc).filter((k) => k.startsWith('x-'))).toEqual([]);
    });

    it('every supportedInterfaces entry satisfies AgentInterface', () => {
        const doc = wire(card().signed);
        const ifaces = doc['supportedInterfaces'] as Array<Record<string, unknown>>;
        expect(ifaces.length).toBeGreaterThan(1);
        const allowed = new Set(allJsonNames('AgentInterface'));
        for (const iface of ifaces) {
            for (const req of requiredJsonNames('AgentInterface')) expect(iface[req]).toBeDefined();
            expect(Object.keys(iface).filter((k) => !allowed.has(k))).toEqual([]);
        }
    });

    it('lists BOTH protocol versions at the SAME url — the header picks, not the address', () => {
        const doc = wire(card().signed);
        const ifaces = doc['supportedInterfaces'] as Array<Record<string, string>>;
        expect(ifaces.map((i) => i.protocolVersion).sort()).toEqual(['0.3.0', '1.0.1']);
        expect(new Set(ifaces.map((i) => i.url)).size).toBe(1);
        // v1.0's native tenant scoping, carrying what the URL already encodes.
        for (const i of ifaces) expect(i.tenant).toBe('acme');
    });
});

describe('the Inflect extension', () => {
    it('declares itself NOT required, or every v1.0 client would be refused', () => {
        // §3.3.4 obliges a server to return ExtensionSupportRequiredError when
        // it marks an extension required and the client does not declare
        // support. Every v1.0 client in existence is in that position.
        const ext = card().signed.capabilities.extensions[0];
        expect(ext.required).toBe(false);
        expect(ext.uri).toBe(INFLECT_V1_CARD_EXTENSION_URI);
    });

    it('is a URN, not a fetchable URL', () => {
        // A URI as an IDENTIFIER. An https URL invites a fetch of something
        // that is not there, and a per-deployment URL would give the same
        // extension a different identity on every deployment.
        expect(INFLECT_V1_CARD_EXTENSION_URI.startsWith('urn:')).toBe(true);
        expect(INFLECT_V1_CARD_EXTENSION_URI).not.toMatch(/^https?:/);
    });

    it('satisfies AgentExtension’s own field set', () => {
        const ext = wire(card().signed.capabilities.extensions[0]);
        const allowed = new Set(allJsonNames('AgentExtension'));
        expect(Object.keys(ext).filter((k) => !allowed.has(k))).toEqual([]);
    });

    it('carries the identity, receipt format, keys and the signature', () => {
        const params = card().signed.capabilities.extensions[0].params;
        expect(params.identity).toBe(`${ORIGIN}/api/a2a/acme/agent-card.json`);
        expect(params.signingKeys.some((k) => k.status === 'CURRENT')).toBe(true);
        expect(params.signature.alg).toBe('Ed25519');
        expect(params.signature.value).toMatch(/^[0-9a-f]{128}$/);
    });

    it('refuses to sign with a key the card does not name as current', () => {
        const { unsigned } = card();
        const other = a2aSigningKeyFromSeed(mintA2aSigningSeed());
        if (!other) throw new Error('no key');
        // The check the separate v1 signer exists to keep unconditional.
        expect(() => signInflectV1Card(unsigned, other)).toThrow(/names as current/);
    });
});

describe('version negotiation', () => {
    it('treats an ABSENT header as 0.3, which is what the spec says', () => {
        // specification.md:712 — "except for 0.3 Clients - 0.3 will be assumed
        // for empty header". This is the assertion that protects every caller
        // that existed before this change.
        for (const absent of [null, undefined, '', '   ']) {
            expect(resolveA2aVersion(absent)).toEqual({ ok: true, version: '0.3' });
        }
    });

    it('accepts both the two-part and three-part spellings', () => {
        // The spec's example value is `0.3`; our own card has advertised
        // `0.3.0` since #3742, and a caller echoing the card must not be
        // refused for it.
        for (const v of ['0.3', '0.3.0']) expect(resolveA2aVersion(v)).toEqual({ ok: true, version: '0.3' });
        for (const v of ['1.0', '1.0.1']) expect(resolveA2aVersion(v)).toEqual({ ok: true, version: '1.0' });
    });

    it('refuses an unsupported version with the spec’s own error', () => {
        for (const v of ['2.0', '0.2', 'banana', '1']) {
            expect(resolveA2aVersion(v)).toMatchObject({ ok: false, error: 'VersionNotSupportedError' });
        }
    });

    it('serves exactly the versions the card advertises', () => {
        // The card and the dispatcher must agree, or one of them is lying.
        const advertised = (wire(card().signed)['supportedInterfaces'] as Array<Record<string, string>>)
            .map((i) => i.protocolVersion.split('.').slice(0, 2).join('.'))
            .sort();
        expect(advertised).toEqual([...A2A_SUPPORTED_VERSIONS].sort());
    });

    it('names the header as Node delivers it', () => {
        expect(A2A_VERSION_HEADER).toBe(A2A_VERSION_HEADER.toLowerCase());
    });
});

describe('v1.0 method names', () => {
    it('aliases SendMessage and GetTask onto the v0.3 names', () => {
        expect(resolveV1Method('SendMessage')).toEqual({ kind: 'ALIASED', v03Method: 'message/send' });
        expect(resolveV1Method('GetTask')).toEqual({ kind: 'ALIASED', v03Method: 'tasks/get' });
    });

    it('refuses ListTasks and CancelTask with UnsupportedOperationError', () => {
        // Decided, not overlooked: both would grant an outside caller new
        // authority — enumerating another organisation's activity, and
        // aborting a run a person may be reviewing — and a wire binding is not
        // where that gets decided. See `version.ts` for the reasoning.
        for (const m of ['ListTasks', 'CancelTask']) {
            expect(resolveV1Method(m)).toEqual({ kind: 'REFUSED', error: 'UnsupportedOperationError' });
        }
    });

    it('refuses push-notification operations with the capability error the spec names', () => {
        // §3.3.4 requires PushNotificationNotSupportedError when the card does
        // not declare the capability — and ours declares it false.
        expect(card().signed.capabilities.pushNotifications).toBe(false);
        expect(resolveV1Method('CreateTaskPushNotificationConfig')).toEqual({
            kind: 'REFUSED',
            error: 'PushNotificationNotSupportedError',
        });
    });

    it('leaves the v0.3 names alone, so both vocabularies work', () => {
        for (const m of ['message/send', 'tasks/get']) {
            expect(resolveV1Method(m)).toEqual({ kind: 'NOT_V1' });
        }
    });

    it('every v1.0 RPC in the proto is either aliased or explicitly refused', () => {
        // DERIVED FROM THE PROTO: a v1.0 operation this build has never heard
        // of would otherwise fall through to NOT_V1 and be refused as an
        // unknown method, which tells a conformant client the wrong thing.
        const rpcs = [...PROTO.matchAll(/^\s*rpc\s+(\w+)\(/gm)].map((m) => m[1]);
        expect(rpcs.length).toBeGreaterThan(8);
        const unhandled = rpcs.filter((r) => resolveV1Method(r).kind === 'NOT_V1');
        expect(unhandled).toEqual([]);
    });
});

describe('TASK_STATE_* is a relabel, not a second opinion', () => {
    it('every v0.3 state has a v1.0 spelling', () => {
        const states: A2aTaskState[] = [
            'submitted',
            'working',
            'input-required',
            'completed',
            'canceled',
            'failed',
            'rejected',
        ];
        expect([...V1_RELABELLED_STATES].sort()).toEqual([...states].sort());
    });

    it('every v1.0 spelling exists in the proto’s TaskState enum', () => {
        // Checked against the bytes, not against a list in our own source.
        const fromProto = new Set(protoEnumValues(PROTO, 'TaskState'));
        expect(fromProto.size).toBe(9);
        for (const s of V1_RELABELLED_STATES) expect(fromProto.has(v1TaskState(s))).toBe(true);
    });

    it('a run reaches the same conclusion in either vocabulary', () => {
        // The equivalence #3866 asks for: one decision about the run, two
        // spellings of it. A second mapping straight from run status to
        // TASK_STATE_* could disagree, and a caller using one version would
        // never see the disagreement.
        for (const status of ['COMPLETED', 'FAILED', 'ABORTED', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED', 'NONSENSE']) {
            const v03 = taskStateForRunStatus(status);
            expect(v1TaskState(v03)).toBe(
                { completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED', working: 'TASK_STATE_WORKING', submitted: 'TASK_STATE_SUBMITTED', 'input-required': 'TASK_STATE_INPUT_REQUIRED', rejected: 'TASK_STATE_REJECTED' }[v03],
            );
        }
    });

    it('an AWAITING_APPROVAL run is WORKING in v1.0 too, not INPUT_REQUIRED', () => {
        // The #3863 decision survives the version change: the approval comes
        // from inside the workspace, so naming the caller as the actor would be
        // as wrong in v1.0 as in v0.3 — and v1.0 HAS the state, so this is a
        // choice rather than an absence.
        expect(protoEnumValues(PROTO, 'TaskState')).toContain('TASK_STATE_INPUT_REQUIRED');
        expect(v1TaskState(taskStateForRunStatus('AWAITING_APPROVAL'))).toBe('TASK_STATE_WORKING');
    });
});
