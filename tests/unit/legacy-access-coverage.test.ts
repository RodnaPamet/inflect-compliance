/**
 * #3325 — a legacy snapshot's population coverage, as every surface reads it.
 *
 * Two halves. The reader, `frozenCampaignCoverage`, is an ALLOWLIST: only the
 * literal 'VERIFIED' on every frozen subject is verified, so a subject frozen
 * before the column existed, a malformed one and an empty campaign all read
 * UNKNOWN — the direction that cannot overclaim. And the evidence PDF, which
 * must print "coverage unverified" in the source section rather than leave the
 * payload hash to be read as a whole-population claim.
 *
 * The PDF half asserts the TEXT, captured as it reaches `addParagraph`, because
 * a render-to-buffer assertion passes whichever sentence is printed.
 */
const mockParagraphs: string[] = [];

jest.mock('@/lib/pdf/sections', () => {
    const actual = jest.requireActual('@/lib/pdf/sections');
    return {
        ...actual,
        addParagraph: (doc: unknown, text: string, ...rest: unknown[]) => {
            mockParagraphs.push(text);
            return actual.addParagraph(doc, text, ...rest);
        },
    };
});

import {
    POPULATION_COVERAGES,
    frozenCampaignCoverage,
    readPopulationCoverage,
} from '@/lib/legacy-access/coverage';
import {
    generateAccessReviewPdf,
    populationCoverageStatement,
    type AccessReviewPdfInput,
} from '@/app-layer/reports/pdf/accessReview';

/** A LEGACY_APP subject's frozen snapshot, with the provenance `createLegacyAccessReview` writes. */
const subject = (populationCoverage?: unknown) => ({
    accountKey: 'jsmith',
    provenance: {
        snapshotId: 'snap-1',
        payloadHash: 'a'.repeat(64),
        mappingVersion: 3,
        connectionId: 'conn-1',
        ...(populationCoverage === undefined ? {} : { populationCoverage }),
    },
});

describe('readPopulationCoverage — only the literal is verified', () => {
    it('reads VERIFIED as VERIFIED and everything else as UNKNOWN', () => {
        expect(readPopulationCoverage('VERIFIED')).toBe('VERIFIED');
        for (const v of ['UNKNOWN', undefined, null, '', 'verified', 'COMPLETE', true, 1]) {
            expect(readPopulationCoverage(v)).toBe('UNKNOWN');
        }
    });

    it('the stored set is exactly the two values, UNKNOWN first — the schema default', () => {
        expect(POPULATION_COVERAGES).toEqual(['UNKNOWN', 'VERIFIED']);
    });
});

describe('frozenCampaignCoverage — what a campaign may claim about its population', () => {
    it('a campaign of UNKNOWN subjects is UNKNOWN', () => {
        expect(frozenCampaignCoverage([subject('UNKNOWN'), subject('UNKNOWN')])).toBe('UNKNOWN');
    });

    it('is VERIFIED only when every subject says so', () => {
        expect(frozenCampaignCoverage([subject('VERIFIED'), subject('VERIFIED')])).toBe('VERIFIED');
        expect(frozenCampaignCoverage([subject('VERIFIED'), subject('UNKNOWN')])).toBe('UNKNOWN');
    });

    it('a subject frozen BEFORE the column existed reads UNKNOWN, and so drags the campaign down', () => {
        // Accurate rather than cautious: no snapshot taken before #3325 was ever
        // verified, because nothing could verify one.
        expect(frozenCampaignCoverage([subject()])).toBe('UNKNOWN');
        expect(frozenCampaignCoverage([subject('VERIFIED'), subject()])).toBe('UNKNOWN');
    });

    it('a malformed snapshot is UNKNOWN, never a throw', () => {
        for (const bad of [null, undefined, 'x', 42, [], {}, { provenance: null }, { provenance: [] }]) {
            expect(frozenCampaignCoverage([bad])).toBe('UNKNOWN');
        }
    });

    it('ZERO IS NEVER COMPLETE — an empty campaign is UNKNOWN, though [].every() is true', () => {
        expect(frozenCampaignCoverage([])).toBe('UNKNOWN');
    });
});

// ─── The evidence ───────────────────────────────────────────────────────

function pdfInput(over: Partial<AccessReviewPdfInput> = {}): AccessReviewPdfInput {
    return {
        tenantName: 'Acme Corp',
        campaignName: 'Q4 legacy recertification',
        campaignDescription: null,
        scope: 'LEGACY_APP',
        periodStartIso: null,
        periodEndIso: null,
        reviewerEmail: 'reviewer@example.com',
        createdByEmail: 'creator@example.com',
        closedByEmail: 'closer@example.com',
        closedAtIso: '2026-10-26T09:00:00.000Z',
        decisions: [{
            subjectUserEmail: 'jsmith@example.com',
            subjectUserName: 'J Smith',
            snapshotRole: 'DIRECTORY_USER',
            snapshotMembershipStatus: 'MFA_MISSING',
            decision: 'CONFIRM',
            decidedAtIso: '2026-10-25T09:00:00.000Z',
            notes: null,
            modifiedToRole: null,
            executionOutcome: 'EXECUTED',
            resolutionMethod: 'EMAIL_EXACT',
        }],
        legacyProvenance: { snapshotId: 'snap-1', payloadHash: 'a'.repeat(64), mappingVersion: 3, connectionId: 'conn-1' },
        ...over,
    };
}

/** Render, drain, and return what reached `addParagraph`. */
async function renderedParagraphs(input: AccessReviewPdfInput): Promise<string[]> {
    mockParagraphs.length = 0;
    const doc = generateAccessReviewPdf(input);
    await new Promise<void>((resolve, reject) => {
        doc.on('data', () => undefined);
        doc.on('end', () => resolve());
        doc.on('error', reject);
        doc.end();
    });
    return [...mockParagraphs];
}

const UNVERIFIED = populationCoverageStatement('UNKNOWN');
const VERIFIED = populationCoverageStatement('VERIFIED');

describe('the evidence PDF states the coverage of what was certified', () => {
    it('the UNKNOWN sentence says the artefact does not attest a whole population', () => {
        expect(UNVERIFIED.startsWith('Population coverage: UNVERIFIED.')).toBe(true);
        expect(UNVERIFIED).toContain("does not attest that they are the application's whole population");
        // The two sentences must not be confusable.
        expect(VERIFIED.startsWith('Population coverage: VERIFIED.')).toBe(true);
        expect(VERIFIED).not.toContain('UNVERIFIED');
    });

    it('a LEGACY_APP campaign over an UNKNOWN snapshot prints the unverified sentence, right after the hash', async () => {
        const paragraphs = await renderedParagraphs(pdfInput({ legacyPopulationCoverage: 'UNKNOWN' }));
        const hashAt = paragraphs.findIndex((p) => p.startsWith('Certified against snapshot snap-1'));
        expect(hashAt).toBeGreaterThanOrEqual(0);
        // Adjacent to the hash, because the hash is the sentence most easily
        // misread as a whole-population claim.
        expect(paragraphs[hashAt + 1]).toBe(UNVERIFIED);
        expect(paragraphs).not.toContain(VERIFIED);
    });

    it('a VERIFIED snapshot prints the verified sentence and not the caveat', async () => {
        const paragraphs = await renderedParagraphs(pdfInput({ legacyPopulationCoverage: 'VERIFIED' }));
        expect(paragraphs).toContain(VERIFIED);
        expect(paragraphs).not.toContain(UNVERIFIED);
    });

    it('the caveat renders even when the subjects carried no readable provenance', async () => {
        // A legacy campaign that cannot show its hash can still less show a
        // whole population; the section must not vanish with the provenance.
        const paragraphs = await renderedParagraphs(
            pdfInput({ legacyProvenance: null, legacyPopulationCoverage: 'UNKNOWN' }),
        );
        expect(paragraphs).toContain(UNVERIFIED);
    });

    it('a campaign of any other scope says nothing about population coverage', async () => {
        const paragraphs = await renderedParagraphs(
            pdfInput({ scope: 'CONNECTED_APP', legacyProvenance: null, legacyPopulationCoverage: undefined }),
        );
        expect(paragraphs.some((p) => p.startsWith('Population coverage:'))).toBe(false);
    });
});
