/**
 * Structural ratchet for vendor-document → assessment pre-fill.
 *
 * Locks the brief's load-bearing safety properties:
 *   - extraction is Zod-VALIDATED (shape + value; safeParse, not a raw cast);
 *   - propose-NOT-commit: the extract path writes VendorAnswerProposal rows,
 *     NEVER a VendorAssessmentAnswer — only the human-triggered approve path
 *     materialises an answer;
 *   - every proposal carries a source CITATION;
 *   - document text is SANITIZED before the AI call (privacy boundary);
 *   - exceptions → proposed finding is opt-in + idempotent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const VENDOR_SCHEMA = read('prisma/schema/vendor.prisma');
const MIGRATION = read('prisma/migrations/20260701140000_vendor_doc_extraction/migration.sql');
const AI = read('src/app-layer/ai/vendor-doc/index.ts');
const USECASE = read('src/app-layer/usecases/vendor-doc-extraction.ts');
const MAP = read('src/app-layer/services/soc2-question-map.ts');

describe('vendor-doc — schema + RLS', () => {
    it('defines VendorDocExtraction + VendorAnswerProposal, tenant-scoped', () => {
        expect(VENDOR_SCHEMA).toMatch(/model\s+VendorDocExtraction\s*\{/);
        expect(VENDOR_SCHEMA).toMatch(/model\s+VendorAnswerProposal\s*\{/);
        const prop = VENDOR_SCHEMA.match(/model\s+VendorAnswerProposal\s*\{[\s\S]*?\n\}/)![0];
        expect(prop).toMatch(/tenantId\s+String/);
        expect(prop).toMatch(/@@index\(\[tenantId/);
    });

    it('applies the RLS triple to both tables', () => {
        for (const table of ['VendorDocExtraction', 'VendorAnswerProposal']) {
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+ENABLE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${table}"`));
        }
    });
});

describe('vendor-doc — AI extraction is sanitized + Zod-validated', () => {
    it('validates the model output against a Zod schema (safeParse, shape + value)', () => {
        expect(AI).toMatch(/export const DocExtractionSchema\s*=\s*z\.object/);
        expect(AI).toMatch(/DocExtractionSchema\.safeParse/);
        // malformed output → empty extraction, not a throw into the caller.
        expect(AI).toMatch(/schema_validation_failed|EMPTY_EXTRACTION/);
    });

    it('sanitizes the document text BEFORE the AI call (privacy boundary)', () => {
        expect(AI).toMatch(/export function sanitizeDocText/);
        expect(AI).toMatch(/\[email\]/); // redacts email PII
        // the usecase sanitizes, THEN extracts.
        const sanitizeIdx = USECASE.indexOf('sanitizeDocText(');
        const extractIdx = USECASE.indexOf('extractDocument(');
        expect(sanitizeIdx).toBeGreaterThan(-1);
        expect(extractIdx).toBeGreaterThan(sanitizeIdx);
    });
});

describe('vendor-doc — propose-not-commit (the core safety contract)', () => {
    it('the extract path writes PROPOSALS with citations, NEVER a VendorAssessmentAnswer', () => {
        expect(USECASE).toMatch(/vendorAnswerProposal\.create/);
        expect(USECASE).toMatch(/sourceCitation/);
        expect(USECASE).toMatch(/status:\s*'PENDING'/);
        // extractVendorDocument must NOT write an assessment answer directly.
        const extractFn = USECASE.match(/export async function extractVendorDocument[\s\S]*?\n\}\n/)![0];
        expect(extractFn).not.toMatch(/vendorAssessmentAnswer\.(create|upsert)/);
    });

    it('ONLY the human-triggered approve path materialises an answer', () => {
        expect(USECASE).toMatch(/export async function approveProposal/);
        const approveFn = USECASE.match(/export async function approveProposal[\s\S]*?\n\}\n/)![0];
        expect(approveFn).toMatch(/vendorAssessmentAnswer\.upsert/);
        expect(approveFn).toMatch(/status:\s*'ACCEPTED'/);
        expect(approveFn).toMatch(/createdAnswerId/);
    });

    it('the mapping is curated, transparent reference data (not a black box)', () => {
        expect(MAP).toMatch(/export const SOC2_TOPICS/);
        expect(MAP).toMatch(/export function controlEvidencesQuestion/);
    });
});

describe('vendor-doc — exceptions → proposed finding (opt-in + idempotent)', () => {
    it('is gated on an explicit opt-in and deduped by sourceKind + sourceRef', () => {
        expect(USECASE).toMatch(/materializeExceptions/);
        expect(USECASE).toMatch(/VENDOR_DOC_EXCEPTION_KIND\s*=\s*'VENDOR_DOC_EXCEPTION'/);
        expect(USECASE).toMatch(/createFinding\(/);
        expect(USECASE).toMatch(/sourceRef/);
        // idempotent: skips already-materialised exceptions.
        expect(USECASE).toMatch(/seen\.has\(sourceRef\)/);
    });
});
