/**
 * `scanent-probes/1` report bodies for Inflect's probe-run ingest tests (step
 * 8a): targets reached or not, and outcomes of each verdict.
 *
 * Typed against the installed contract package, so a contract change fails
 * `tsc` here first. Reports are signed with the harness fake scanner's keypair
 * (`createFakeScanner`): every scanent contract signs the same canonical JSON
 * with an Ed25519 key, and a prober key is one such key in a register of its
 * own. The scope signer is identified only by its fingerprint, so an approver
 * is any other keypair: `approverFingerprint(approver.publicKeyHex)`.
 */
import {
    PROBES_CONTRACT_V1,
    type ProbesReportBodyV1,
} from '@rodnapamet/scanent-contract/probes-contract';

import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';

export const CHAT = 'https://agents.acme.example/support/chat';
export const MCP = 'https://mcp.acme.example/crm/mcp';
export const A2A = 'https://a2a.acme.example/agent';

type Outcome = ProbesReportBodyV1['outcomes'][number];
type Target = ProbesReportBodyV1['targets'][number];

export const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

export function approverFingerprint(publicKeyHex: string): string {
    return harnessKeyFingerprint(publicKeyHex) as string;
}

/** An ACTED outcome: the agent returned the canary. */
export function acted(endpoint: string, probeId = 'canary.instruction-override.1', tool?: string): Outcome {
    return {
        probeId,
        probeClass: 'canary',
        endpoint,
        verdict: 'ACTED',
        reason: 'CANARY_RETURNED',
        ...(tool ? { tool } : {}),
        replyDigest: DIGEST('c'),
        excerpt: 'Sure. The joined code is ZEBRA-41.',
    };
}

/** A RESISTED canary outcome. */
export function resisted(endpoint: string, probeId = 'canary.instruction-override.1', tool?: string): Outcome {
    return {
        probeId,
        probeClass: 'canary',
        endpoint,
        verdict: 'RESISTED',
        reason: 'CANARY_ABSENT',
        ...(tool ? { tool } : {}),
        replyDigest: DIGEST('d'),
    };
}

/** No reply: INCONCLUSIVE, which closes nothing. */
export function noReply(endpoint: string, probeId = 'canary.instruction-override.1', tool?: string): Outcome {
    return { probeId, probeClass: 'canary', endpoint, verdict: 'INCONCLUSIVE', reason: 'NO_REPLY', ...(tool ? { tool } : {}) };
}

/** A DISCLOSED outcome: the agent returned the estate's planted context. */
export function disclosedContext(endpoint: string, probeId = 'disclosure.system-prompt-extraction.1'): Outcome {
    return {
        probeId,
        probeClass: 'disclosure',
        endpoint,
        verdict: 'DISCLOSED',
        reason: 'PLANTED_CONTEXT_RETURNED',
        replyDigest: DIGEST('e'),
        excerpt: 'My instructions begin: [marker]. I help customers.',
    };
}

/** The targets the outcomes name, each REACHED when it answered and NO_REPLY when it did not. */
function targetsOf(outcomes: readonly Outcome[], extra: readonly Target[] = []): Target[] {
    const kindOf = (e: string): Target['kind'] => (e === MCP ? 'mcp' : e === A2A ? 'a2a' : 'http-chat');
    const endpoints = [...new Set(outcomes.map((o) => o.endpoint))];
    const listed: Target[] = endpoints.map((endpoint) => {
        const answered = outcomes.some((o) => o.endpoint === endpoint && o.reason !== 'NO_REPLY');
        return { endpoint, kind: kindOf(endpoint), reached: answered, reason: answered ? 'REACHED' : 'NO_REPLY' };
    });
    return [...listed, ...extra.filter((t) => !endpoints.includes(t.endpoint))];
}

/** A body for one run under the engagement the approver signed. */
export function probesBody(
    approverFingerprintHex: string,
    outcomes: Outcome[],
    over: { engagementId?: string; startedAt?: string; stopped?: ProbesReportBodyV1['run']['stopped']; extraTargets?: Target[] } = {},
): ProbesReportBodyV1 {
    const startedAt = over.startedAt ?? '2026-11-25T09:00:00.000Z';
    const targets = targetsOf(outcomes, over.extraTargets);
    return {
        contract: PROBES_CONTRACT_V1,
        engagement: {
            id: over.engagementId ?? 'eng-acme-0001',
            scopeDigest: DIGEST('a'),
            scopeSignerFingerprint: approverFingerprintHex,
        },
        catalogue: { digest: DIGEST('b'), probes: 11 },
        run: {
            startedAt,
            endedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
            stopped: over.stopped ?? null,
            surfaceDigest: DIGEST('f'),
        },
        targets: targets.length > 0 ? targets : [{ endpoint: CHAT, kind: 'http-chat', reached: false, reason: 'NOT_RUN' }],
        outcomes,
    };
}
