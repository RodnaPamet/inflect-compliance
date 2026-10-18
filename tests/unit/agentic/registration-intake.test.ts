/**
 * The registration intake's pure half (#3669): what an owner suggestion may
 * contribute — provenance, never the owner — and how a SHADOW_AGENT finding
 * names its discovered agent.
 */
import { createHmac } from 'node:crypto';

import {
    discoveredIdOfShadowFinding,
    HARNESS_FINDING_SOURCE_KIND,
    shadowRefOf,
} from '@/lib/agentic/harness-findings';
import { parseOwnershipAttribution, type OwnershipAttribution } from '@/lib/agentic/iam-skill-outputs';
import {
    REGISTRATION_INTAKE_REFUSALS,
    suggestionNamesOwner,
    suggestionProvenance,
} from '@/lib/agentic/registration-intake';

/** A stand-in for `hashForLookup`: same normalisation, a fixed key. */
const lookupHash = (value: string) => createHmac('sha256', 'test-key').update(value.toLowerCase().trim(), 'utf8').digest('hex');
const owner = { userId: 'usr_jane', emailHash: lookupHash('jane@example.com') };

function attribution(raw: unknown): OwnershipAttribution {
    const parsed = parseOwnershipAttribution(raw);
    if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.issues.join('; ')}`);
    return parsed.value;
}

const suggested = (ref: string) =>
    attribution({
        discoveredAgentId: 'da_1',
        status: 'SUGGESTED',
        proposedOwnerRef: ref,
        grade: 'STRONG',
        signals: [
            { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/9f1c#owners', personRef: ref, personActive: true },
            { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/9f1c#tags', personRef: null, personActive: null },
        ],
    });

describe('suggestionNamesOwner — is the suggested person the confirmed owner?', () => {
    it('by user id', () => {
        expect(suggestionNamesOwner('usr_jane', owner, lookupHash)).toBe(true);
    });

    it('by e-mail, whatever its case or surrounding space', () => {
        expect(suggestionNamesOwner('Jane@Example.COM', owner, lookupHash)).toBe(true);
        expect(suggestionNamesOwner(' jane@example.com ', owner, lookupHash)).toBe(true);
    });

    it('not for another person, a non-e-mail reference, or an owner with no stored hash', () => {
        expect(suggestionNamesOwner('john@example.com', owner, lookupHash)).toBe(false);
        expect(suggestionNamesOwner('entra:user:6b2d', owner, lookupHash)).toBe(false);
        expect(suggestionNamesOwner('jane@example.com', { userId: 'usr_jane', emailHash: null }, lookupHash)).toBe(false);
    });

    it('hashes only an e-mail-shaped reference', () => {
        const hash = jest.fn(lookupHash);
        suggestionNamesOwner('entra:user:6b2d', owner, hash);
        expect(hash).not.toHaveBeenCalled();
    });
});

describe('suggestionProvenance — what the intake records about a suggestion', () => {
    it('a SUGGESTED answer: its grade, its signals by kind and evidence, and whether it named the confirmed owner', () => {
        expect(suggestionProvenance(suggested('jane@example.com'), owner, lookupHash)).toEqual({
            status: 'SUGGESTED',
            grade: 'STRONG',
            unmatchedReason: null,
            signals: [
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/9f1c#owners', namesPerson: true },
                { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/9f1c#tags', namesPerson: false },
            ],
            confirmedOwnerIsSuggested: true,
        });
        expect(suggestionProvenance(suggested('john@example.com'), owner, lookupHash).confirmedOwnerIsSuggested).toBe(false);
    });

    it('never carries the suggested person’s reference, or any signal’s', () => {
        const recorded = JSON.stringify(suggestionProvenance(suggested('john@example.com'), owner, lookupHash));
        expect(recorded).not.toContain('john@example.com');
        expect(recorded).not.toContain('personRef');
        expect(recorded).not.toContain('proposedOwnerRef');
    });

    it('an AMBIGUOUS answer suggested nobody, so there is nothing to agree with', () => {
        const tie = attribution({
            discoveredAgentId: 'da_1',
            status: 'AMBIGUOUS',
            signals: [
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:a#owners', personRef: 'a@example.com', personActive: true },
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:a#owners', personRef: 'b@example.com', personActive: true },
            ],
        });
        expect(suggestionProvenance(tie, owner, lookupHash)).toMatchObject({
            status: 'AMBIGUOUS',
            grade: null,
            unmatchedReason: null,
            confirmedOwnerIsSuggested: null,
        });
    });

    it('an UNMATCHED answer keeps its reason', () => {
        const orphan = attribution({
            discoveredAgentId: 'da_1',
            status: 'UNMATCHED',
            reason: 'OWNER_DEPARTED',
            signals: [{ kind: 'CREDENTIAL_ACTOR', evidence: 'vault:kv/x#rotatedBy', personRef: 'gone@example.com', personActive: false }],
        });
        expect(suggestionProvenance(orphan, owner, lookupHash)).toMatchObject({
            status: 'UNMATCHED',
            unmatchedReason: 'OWNER_DEPARTED',
            confirmedOwnerIsSuggested: null,
        });
    });
});

describe('a SHADOW_AGENT finding names its discovered agent', () => {
    it('round-trips a discovered id, colons included', () => {
        const id = 'entra:sp:9f1c-44aa';
        expect(discoveredIdOfShadowFinding({ sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: shadowRefOf(id) })).toBe(id);
    });

    it('is null for any other finding', () => {
        expect(discoveredIdOfShadowFinding({ sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: 'UNPINNED_WRITE_TOOL:entra:sp:x' })).toBeNull();
        expect(discoveredIdOfShadowFinding({ sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: 'SHADOW_AGENT:' })).toBeNull();
        expect(discoveredIdOfShadowFinding({ sourceKind: 'MANUAL', sourceRef: shadowRefOf('entra:sp:x') })).toBeNull();
        expect(discoveredIdOfShadowFinding({ sourceKind: null, sourceRef: null })).toBeNull();
    });
});

describe('the refusals are a closed, named set', () => {
    it('lists each reason once', () => {
        expect(new Set(REGISTRATION_INTAKE_REFUSALS).size).toBe(REGISTRATION_INTAKE_REFUSALS.length);
        expect(REGISTRATION_INTAKE_REFUSALS).toEqual(
            expect.arrayContaining(['FINDING_NOT_FOUND', 'NOT_A_SHADOW_AGENT_FINDING', 'ALREADY_REGISTERED', 'ALREADY_REGISTERED_BY_INTAKE', 'OWNER_NOT_CONFIRMED', 'OWNER_NOT_ACTIVE_MEMBER']),
        );
    });
});
