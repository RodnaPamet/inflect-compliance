/**
 * Structural ratchet for the SARIF scanner-ingestion subsystem.
 *
 * Locks the load-bearing decisions from the build brief so a future
 * refactor can't silently regress them:
 *   1. ScannerRun + ScannerFinding models exist, tenant-scoped, with the
 *      RLS triple, encrypted `description`, index coverage, and dedup by
 *      a fingerprint UNIQUE constraint.
 *   2. SARIF is the ONE canonical parser (no per-tool parser sprawl).
 *   3. A passing run materialises Evidence linked to a control via
 *      ControlEvidenceLink (kind INTEGRATION_RESULT) — the first
 *      automated-evidence seam.
 *   4. Failing→Finding is idempotent (sourceKind='SCANNER'), threshold-
 *      gated, and reconciles (closes stale findings on re-scan).
 *   5. NO proprietary composite score (a guard against a CFQI clone).
 *   6. Ingestion unifies with the existing CVE/integration subsystem
 *      rather than forking a parallel finding-ingestion path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/**
 * Comments MASKED at the read seam (#2246). The CFQI-clone guard below is a
 * whole-file `not.toMatch(/CFQI|compositeScore|…/i)` over three concatenated
 * sources — the one shape a comment can flip in the failing direction — and
 * every positive assertion here names an identifier a comment could spell.
 */
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const COMPLIANCE_SCHEMA = readPrismaSchema();
const MIGRATION = read('prisma/migrations/20260701120000_scanner_ingestion/migration.sql');
const ENCRYPTED_FIELDS = read('src/lib/security/encrypted-fields.ts');
const SARIF = read('src/app-layer/services/sarif.ts');
const USECASE = read('src/app-layer/usecases/scanner-ingestion.ts');

describe('scanner ingestion — schema + RLS + encryption + dedup', () => {
    it('defines ScannerRun and ScannerFinding models', () => {
        expect(COMPLIANCE_SCHEMA).toMatch(/model\s+ScannerRun\s*\{/);
        expect(COMPLIANCE_SCHEMA).toMatch(/model\s+ScannerFinding\s*\{/);
    });

    it('both models are tenant-scoped with tenantId-leading indexes', () => {
        const run = COMPLIANCE_SCHEMA.match(/model\s+ScannerRun\s*\{[\s\S]*?\n\}/)![0];
        const finding = COMPLIANCE_SCHEMA.match(/model\s+ScannerFinding\s*\{[\s\S]*?\n\}/)![0];
        expect(run).toMatch(/tenantId\s+String/);
        expect(run).toMatch(/@@index\(\[tenantId/);
        expect(finding).toMatch(/tenantId\s+String/);
        expect(finding).toMatch(/@@index\(\[tenantId/);
    });

    it('dedups ScannerFinding by a (tenantId, fingerprint) UNIQUE constraint', () => {
        const finding = COMPLIANCE_SCHEMA.match(/model\s+ScannerFinding\s*\{[\s\S]*?\n\}/)![0];
        expect(finding).toMatch(/fingerprint\s+String/);
        expect(finding).toMatch(/@@unique\(\[tenantId,\s*fingerprint\]\)/);
        // the migration enforces it too
        expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[^\n]*"ScannerFinding"[^\n]*"tenantId",\s*"fingerprint"/);
    });

    it('applies the canonical RLS triple to BOTH tables in the migration', () => {
        for (const table of ['ScannerRun', 'ScannerFinding']) {
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+ENABLE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${table}"`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation_insert ON "${table}"`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${table}"`));
        }
    });

    it('encrypts the free-text ScannerFinding.description (Epic B manifest)', () => {
        expect(ENCRYPTED_FIELDS).toMatch(/ScannerFinding:\s*\[\s*'description'\s*\]/);
    });
});

describe('scanner ingestion — SARIF is the canonical parser', () => {
    it('exposes parseSarif as the normalisation entry point', () => {
        expect(SARIF).toMatch(/export function parseSarif/);
    });

    it('does NOT fork a parser-per-tool (no trivy/zap/semgrep parser modules)', () => {
        const servicesDir = path.join(ROOT, 'src/app-layer/services');
        const offenders = fs
            .readdirSync(servicesDir)
            .filter((f) => /(trivy|zap|gitleaks|checkov|semgrep|codeql).*pars|pars.*(trivy|zap|gitleaks|checkov|semgrep|codeql)/i.test(f));
        expect(offenders).toEqual([]);
    });
});

describe('scanner ingestion — automated control evidence (the first seam)', () => {
    it('a passing run materialises Evidence linked via ControlEvidenceLink/INTEGRATION_RESULT', () => {
        expect(USECASE).toMatch(/outcome\s*===\s*'PASS'/);
        expect(USECASE).toMatch(/evidence\.(create|update)/);
        expect(USECASE).toMatch(/controlEvidenceLink\.create/);
        expect(USECASE).toMatch(/kind:\s*'INTEGRATION_RESULT'/);
    });

    it('the evidence carries a freshness window (reuses the stale-review sweep)', () => {
        expect(USECASE).toMatch(/nextReviewDate/);
    });
});

describe('scanner ingestion — failing findings reconcile idempotently', () => {
    it("materialises Findings tagged sourceKind='SCANNER' via the existing usecase", () => {
        expect(USECASE).toMatch(/SCANNER_SOURCE_KIND\s*=\s*'SCANNER'/);
        expect(USECASE).toMatch(/createFinding\(/);
        expect(USECASE).toMatch(/sourceRef:/);
    });

    it('is threshold-gated (does not raise a Finding per lint hit)', () => {
        expect(USECASE).toMatch(/findingThreshold|DEFAULT_FINDING_THRESHOLD/);
        expect(USECASE).toMatch(/aboveThreshold/);
    });

    it('reconciles: closes scanner Findings whose finding is no longer reported', () => {
        expect(USECASE).toMatch(/staleRefs/);
        expect(USECASE).toMatch(/status:\s*'CLOSED'/);
    });
});

describe('scanner ingestion — no proprietary score; unify with the security-signal subsystem', () => {
    it('introduces NO opaque composite score (CFQI clone guard)', () => {
        const blob = SARIF + USECASE + read('src/app-layer/services/cwe-mapping.ts');
        expect(blob).not.toMatch(/CFQI|compositeScore|composite_score|proprietaryScore|qualityIndex/i);
        // coverage is expressed as control-evidence completeness, not a grade.
        expect(blob).not.toMatch(/\bgrade\s*[:=]/i);
    });

    it('reuses the existing Finding sourceKind materialiser (same path as CVE conversion)', () => {
        // vulnerability.ts is the sibling connector — both use createFinding + sourceKind.
        const vuln = read('src/app-layer/usecases/vulnerability.ts');
        expect(vuln).toMatch(/sourceKind:\s*'CVE'/);
        expect(USECASE).toMatch(/createFinding\(/);
        expect(USECASE).toMatch(/sourceKind/);
    });

    it('reuses the integration framework seam (INTEGRATION_RESULT evidence link)', () => {
        expect(USECASE).toMatch(/INTEGRATION_RESULT/);
        expect(USECASE).toMatch(/integrationResultId/);
    });
});
