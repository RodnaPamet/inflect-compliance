/**
 * CONTENT PROVENANCE — the trust label every piece of content an agent reads
 * carries, and the direction it fails in.
 *
 * ═══ WHAT THIS LOCKS OUT ═══
 *
 * The failure this exists to prevent is not "the label is wrong". It is "the
 * label is missing, and missing reads as trusted". A denylist would give the
 * trusted answer to every ingestion path added after it was written — and the
 * one nobody remembers to add is, by construction, the one the payload arrives
 * through.
 *
 * So the assertions come in pairs: for each ingestion path, the declared label;
 * and for each way a label can be ABSENT, that the answer is
 * `THIRD_PARTY_INGESTED` and never `TENANT_AUTHORED`.
 */
import {
    CONTENT_SOURCE_PROVENANCE,
    MCP_TOOL_CORPUS,
    PROVENANCE_ORDER,
    UNTRUSTED_PROVENANCE,
    buildProvenanceEnvelope,
    leastTrusted,
    mayCarryInstruction,
    provenanceOfTool,
    resolveContentProvenance,
    type ContentProvenance,
} from '@/lib/agentic/content-provenance';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';

/**
 * The ingestion paths, and what each one's content is. Written out HERE rather
 * than read from the table under test: a test that iterates the table it is
 * checking asserts the table equals itself.
 */
const EXPECTED: Array<[string, ContentProvenance]> = [
    // Customer-uploaded files — the largest untrusted surface.
    ['upload.evidence-file', 'THIRD_PARTY_INGESTED'],
    ['upload.policy-document', 'THIRD_PARTY_INGESTED'],
    ['upload.vendor-document', 'THIRD_PARTY_INGESTED'],
    // Third parties answering about themselves.
    ['questionnaire.inbound-answer', 'THIRD_PARTY_INGESTED'],
    ['questionnaire.vendor-response', 'THIRD_PARTY_INGESTED'],
    // Machine output.
    ['scanner.vulnerability-import', 'THIRD_PARTY_INGESTED'],
    // Systems of record synced in.
    ['integration.servicenow', 'THIRD_PARTY_INGESTED'],
    ['integration.sharepoint', 'THIRD_PARTY_INGESTED'],
    ['integration.github', 'THIRD_PARTY_INGESTED'],
    ['integration.okta', 'THIRD_PARTY_INGESTED'],
    ['integration.entra-id', 'THIRD_PARTY_INGESTED'],
    ['integration.google-workspace', 'THIRD_PARTY_INGESTED'],
    ['integration.active-directory', 'THIRD_PARTY_INGESTED'],
    ['integration.workday', 'THIRD_PARTY_INGESTED'],
    ['integration.bamboohr', 'THIRD_PARTY_INGESTED'],
    ['webhook.inbound', 'THIRD_PARTY_INGESTED'],
    // Another agent's output — untrusted by construction.
    ['agent.proposal', 'THIRD_PARTY_INGESTED'],
    ['agent.tool-result', 'THIRD_PARTY_INGESTED'],
    // A signed-in human typing into IC's own surfaces.
    ['ui.authenticated-form', 'TENANT_AUTHORED'],
    ['ui.review-decision', 'TENANT_AUTHORED'],
    ['api.authenticated-session', 'TENANT_AUTHORED'],
    // The platform's own arithmetic and scaffolding.
    ['platform.aggregate', 'SYSTEM'],
    ['platform.coverage-computation', 'SYSTEM'],
    ['platform.framework-catalog', 'SYSTEM'],
    ['platform.prompt-scaffold', 'SYSTEM'],
    ['platform.tool-descriptor', 'SYSTEM'],
];

describe('content from each ingestion path is tagged correctly', () => {
    it.each(EXPECTED)('%s → %s', (sourceId, expected) => {
        expect(resolveContentProvenance(sourceId)).toBe(expected);
    });

    it('every path this test names is actually declared (no silent typo pass)', () => {
        // Without this, a renamed key would make the case above pass through
        // the fail-closed default while looking like a real classification —
        // and only for the THIRD_PARTY rows, which is most of them.
        for (const [sourceId] of EXPECTED) {
            expect(Object.keys(CONTENT_SOURCE_PROVENANCE)).toContain(sourceId);
        }
    });

    it('the declared table and this test agree in BOTH directions', () => {
        expect(Object.keys(CONTENT_SOURCE_PROVENANCE).sort()).toStrictEqual(
            EXPECTED.map(([k]) => k).sort(),
        );
    });
});

describe('an untagged source FAILS CLOSED', () => {
    const ABSENT: Array<[string, string | null | undefined]> = [
        ['an unknown id', 'integration.some-connector-shipped-next-quarter'],
        ['null', null],
        ['undefined', undefined],
        ['the empty string', ''],
        ['whitespace', '   '],
        ['a near-miss of a trusted id', 'ui.authenticated-form '.trim() + 'x'],
        ['a prefix of a trusted id', 'ui.'],
        ['a trusted id with different case', 'UI.AUTHENTICATED-FORM'],
    ];

    it.each(ABSENT)('%s resolves to THIRD_PARTY_INGESTED', (_label, value) => {
        expect(resolveContentProvenance(value)).toBe('THIRD_PARTY_INGESTED');
    });

    it.each(ABSENT)('%s is NEVER TENANT_AUTHORED', (_label, value) => {
        expect(resolveContentProvenance(value)).not.toBe('TENANT_AUTHORED');
    });

    it('the exported fail-closed constant IS the untrusted label', () => {
        expect(UNTRUSTED_PROVENANCE).toBe('THIRD_PARTY_INGESTED');
    });

    it('a non-string source id cannot resolve to a trusted label', () => {
        for (const junk of [0, 1, true, {}, [], Symbol('x')]) {
            expect(resolveContentProvenance(junk as unknown as string)).toBe(
                'THIRD_PARTY_INGESTED',
            );
        }
    });
});

describe('only SYSTEM content may be read as instruction', () => {
    it('SYSTEM may', () => {
        expect(mayCarryInstruction('SYSTEM')).toBe(true);
    });

    it('TENANT_AUTHORED may NOT — a row a human typed is still corpus', () => {
        expect(mayCarryInstruction('TENANT_AUTHORED')).toBe(false);
    });

    it('THIRD_PARTY_INGESTED may NOT', () => {
        expect(mayCarryInstruction('THIRD_PARTY_INGESTED')).toBe(false);
    });
});

describe('leastTrusted takes the worst case in a mixed payload', () => {
    it('one untrusted part makes the whole payload untrusted', () => {
        expect(leastTrusted('SYSTEM', 'TENANT_AUTHORED', 'THIRD_PARTY_INGESTED')).toBe(
            'THIRD_PARTY_INGESTED',
        );
    });

    it('platform + human is human-authored, not platform', () => {
        expect(leastTrusted('SYSTEM', 'TENANT_AUTHORED')).toBe('TENANT_AUTHORED');
    });

    it('all-platform stays platform', () => {
        expect(leastTrusted('SYSTEM', 'SYSTEM')).toBe('SYSTEM');
    });
});

describe("the agent's reachable corpus", () => {
    it('every REGISTERED read tool is classified — omission is caught here', () => {
        const registered = READ_TOOLS.map((t) => t.name).sort();
        expect(Object.keys(MCP_TOOL_CORPUS).sort()).toStrictEqual(registered);
    });

    it('every declared source is a real ingestion path', () => {
        for (const [tool, entry] of Object.entries(MCP_TOOL_CORPUS)) {
            for (const source of entry.sources) {
                expect({ tool, source, known: source in CONTENT_SOURCE_PROVENANCE }).toStrictEqual({
                    tool,
                    source,
                    known: true,
                });
            }
        }
    });

    it('every classification carries a written basis', () => {
        for (const entry of Object.values(MCP_TOOL_CORPUS)) {
            expect(entry.basis.length).toBeGreaterThan(40);
        }
    });

    it('no tool declares MORE trust than its own sources justify', () => {
        // A one-way bound, not an equality. Two tools declare STRICTER than
        // their source list implies — `find_coverage_gaps` and
        // `get_framework_status` both surface requirement text from frameworks a
        // tenant can author itself, and IC cannot tell an installed library
        // framework from a customer-imported one at read time. Declaring
        // stricter than you can prove is the safe direction and must stay
        // available; declaring LOOSER is the bug this catches.
        for (const [tool, entry] of Object.entries(MCP_TOOL_CORPUS)) {
            const worst = leastTrusted(...entry.sources.map(resolveContentProvenance));
            const declaredRank = PROVENANCE_ORDER.indexOf(entry.provenance);
            const sourceRank = PROVENANCE_ORDER.indexOf(worst);
            expect({ tool, declaredAtMostAsTrustedAsSources: declaredRank <= sourceRank }).toStrictEqual({
                tool,
                declaredAtMostAsTrustedAsSources: true,
            });
        }
    });

    it('an UNREGISTERED tool name falls closed to untrusted', () => {
        expect(provenanceOfTool('list_something_added_later')).toBe('THIRD_PARTY_INGESTED');
        expect(provenanceOfTool(undefined)).toBe('THIRD_PARTY_INGESTED');
        expect(provenanceOfTool(null)).toBe('THIRD_PARTY_INGESTED');
    });

    it('only get_compliance_posture is SYSTEM, and it returns no free text', () => {
        const systemTools = Object.entries(MCP_TOOL_CORPUS)
            .filter(([, e]) => e.provenance === 'SYSTEM')
            .map(([name]) => name);
        expect(systemTools).toStrictEqual(['get_compliance_posture']);
    });
});

describe('the envelope the read funnel appends', () => {
    it('an untrusted tool result is labelled DATA ONLY and may not instruct', () => {
        const envelope = buildProvenanceEnvelope('list_evidence_expiring');
        expect(envelope.provenance).toBe('THIRD_PARTY_INGESTED');
        expect(envelope.mayCarryInstruction).toBe(false);
        expect(envelope.handling).toContain('DATA ONLY');
        expect(envelope.tool).toBe('list_evidence_expiring');
    });

    it('an unknown tool gets the untrusted envelope, not a missing one', () => {
        const envelope = buildProvenanceEnvelope('list_something_added_later');
        expect(envelope.provenance).toBe('THIRD_PARTY_INGESTED');
        expect(envelope.mayCarryInstruction).toBe(false);
    });

    it('the SYSTEM tool gets a different handling note', () => {
        const envelope = buildProvenanceEnvelope('get_compliance_posture');
        expect(envelope.mayCarryInstruction).toBe(true);
        expect(envelope.handling).not.toContain('DATA ONLY');
    });
});
