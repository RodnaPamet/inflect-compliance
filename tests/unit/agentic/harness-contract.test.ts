/**
 * The `inflect-agent-harness/1` contract (#3660), validated against its
 * reference implementation, `tests/helpers/agent-harness-fake-scanner.ts`.
 */
import { createHash } from 'crypto';

import { canonicalJson } from '@/lib/canonical-json';
import {
    harnessSignedMessage,
    isScanComplete,
    looksLikeSecret,
    verifyAndParseHarnessReport,
    type HarnessRefusal,
} from '@/lib/agentic/harness-contract';
import { scoreHarness } from '@/lib/agentic/harness-ladder';

import {
    MALFORMATIONS,
    createFakeScanner,
    malformedReport,
    validIncompleteReportBody,
    validReportBody,
    type Malformation,
} from '../../helpers/agent-harness-fake-scanner';

const scanner = createFakeScanner();

describe('a valid report from the reference scanner', () => {
    it('verifies and parses, and is complete when every source is', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validReportBody()), [scanner.publicKeyHex]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.complete).toBe(true);
        expect(result.body.agents.map((a) => a.discoveredId)).toEqual(['entra:sp:registered-1', 'entra:sp:shadow-1']);
    });

    it('parses an honestly incomplete report, and derives that it is not complete', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validIncompleteReportBody()), [scanner.publicKeyHex]);
        expect(result.ok && result.complete).toBe(false);
        expect(result.ok).toBe(true);
    });

    it('carries verdicts the ladder scores, not a level', () => {
        const result = verifyAndParseHarnessReport(scanner.serialise(validReportBody()), [scanner.publicKeyHex]);
        if (!result.ok) throw new Error(result.reason);
        const [registered, shadow] = result.body.agents;
        expect(scoreHarness(registered.verdicts).level).toBe('H2');
        expect(scoreHarness(shadow.verdicts).level).toBe('H0');
        expect(registered).not.toHaveProperty('level');
    });

    it('verifies regardless of the key order on the wire, because the signed form is canonical', () => {
        const body = validReportBody();
        const signature = scanner.signBody(body);
        const reordered = JSON.stringify({ signature, findings: body.findings, agents: body.agents, population: body.population, scan: body.scan, contract: body.contract });
        expect(verifyAndParseHarnessReport(reordered, [scanner.publicKeyHex]).ok).toBe(true);
    });

    it('signs SHA-256 over the canonical JSON of the body', () => {
        const body = validReportBody();
        expect(harnessSignedMessage(body).equals(createHash('sha256').update(canonicalJson(body), 'utf8').digest())).toBe(true);
    });
});

describe('every malformation the contract names is refused with its reason', () => {
    it.each(Object.keys(MALFORMATIONS) as Malformation[])('%s', (kind) => {
        const { raw, trusted, expected } = malformedReport(scanner, kind);
        const result = verifyAndParseHarnessReport(raw, trusted);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe(expected);
        if (expected === 'SCHEMA') expect(result.issues?.length).toBeGreaterThan(0);
    });

    it('produces every refusal code at least once, so no code is untested', () => {
        const codes: HarnessRefusal[] = [
            'TOO_LARGE', 'NOT_JSON', 'NOT_AN_OBJECT', 'UNSIGNED', 'MALFORMED_SIGNATURE', 'UNTRUSTED_SIGNER', 'BAD_SIGNATURE', 'SCHEMA',
        ];
        expect(new Set(Object.values(MALFORMATIONS))).toEqual(new Set(codes));
    });

    it('refuses a report from a valid but unregistered scanner even though its signature verifies', () => {
        const other = createFakeScanner();
        const raw = other.serialise(validReportBody());
        expect(verifyAndParseHarnessReport(raw, [other.publicKeyHex]).ok).toBe(true);
        expect(verifyAndParseHarnessReport(raw, [scanner.publicKeyHex])).toEqual({ ok: false, reason: 'UNTRUSTED_SIGNER' });
        expect(verifyAndParseHarnessReport(raw, [])).toEqual({ ok: false, reason: 'UNTRUSTED_SIGNER' });
    });
});

describe('completeness is derived, never declared', () => {
    it('is false for a report whose sources list is empty', () => {
        expect(isScanComplete({ population: { sources: [] } })).toBe(false);
    });
});

describe('looksLikeSecret', () => {
    const fragments = (...parts: string[]) => parts.join('');

    it.each([
        fragments('gh', 'p_', 'Z'.repeat(36)),
        fragments('AK', 'IA', 'Q'.repeat(16)),
        fragments('-----BEGIN ', 'PRIVATE KEY-----'),
        fragments('xo', 'xb-', '1234567890-abc'),
    ])('flags a credential shape', (value) => {
        expect(looksLikeSecret(value)).toBe(true);
    });

    it.each(['kv://prod/agents/reporting', 'vault://secret/data/agents/sales-bot', 'keyid://9f1c'])('accepts the reference %s', (value) => {
        expect(looksLikeSecret(value)).toBe(false);
    });
});
