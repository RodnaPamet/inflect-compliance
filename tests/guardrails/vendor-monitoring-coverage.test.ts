/**
 * Structural ratchet for continuous vendor monitoring + breach intelligence.
 *
 * Locks the brief's load-bearing properties (the "assessed once →
 * continuously assured" shift):
 *   - cert / SOC 2 expiry flips the assessment stale (vendor.nextReviewAt →
 *     now) + triggers reassessment;
 *   - a breach / posture-change materialises a vendor Finding (explicit +
 *     idempotent) + notifies the owner;
 *   - external-signal ingestion rides the shared provider + fetchWithRetry
 *     seam, NOT a parallel fetch path;
 *   - RLS + index coverage on the monitoring models;
 *   - the reassessment-reminder is reused (not reimplemented).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const VENDOR_SCHEMA = read('prisma/schema/vendor.prisma');
const MIGRATION = read('prisma/migrations/20260701150000_vendor_monitoring/migration.sql');
const USECASE = read('src/app-layer/usecases/vendor-monitoring.ts');
const JOB = read('src/app-layer/jobs/vendor-monitoring.ts');
const EVAL = read('src/app-layer/services/vendor-monitoring/evaluate.ts');
const BREACH = read('src/app-layer/services/vendor-monitoring/breach-provider.ts');
const TLS = read('src/app-layer/services/vendor-monitoring/tls-provider.ts');

describe('vendor-monitoring — schema + RLS + indexes', () => {
    it('defines VendorMonitor + VendorPostureEvent, tenant-scoped + indexed', () => {
        expect(VENDOR_SCHEMA).toMatch(/model\s+VendorMonitor\s*\{/);
        expect(VENDOR_SCHEMA).toMatch(/model\s+VendorPostureEvent\s*\{/);
        for (const model of ['VendorMonitor', 'VendorPostureEvent']) {
            const block = VENDOR_SCHEMA.match(new RegExp(`model\\s+${model}\\s*\\{[\\s\\S]*?\\n\\}`))![0];
            expect(block).toMatch(/tenantId\s+String/);
            expect(block).toMatch(/@@index\(\[tenantId/);
        }
        // The posture timeline is idempotent via a unique fingerprint.
        const ev = VENDOR_SCHEMA.match(/model\s+VendorPostureEvent\s*\{[\s\S]*?\n\}/)![0];
        expect(ev).toMatch(/@@unique\(\[tenantId,\s*fingerprint\]\)/);
    });

    it('applies the RLS triple to both monitoring tables', () => {
        for (const table of ['VendorMonitor', 'VendorPostureEvent']) {
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+ENABLE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${table}"`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY tenant_isolation_insert ON "${table}"`));
            expect(MIGRATION).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${table}"`));
        }
    });
});

describe('vendor-monitoring — attestation expiry flips stale + triggers reassessment', () => {
    it('evaluates attestation expiry from the parsed report period', () => {
        expect(EVAL).toMatch(/export function evaluateAttestations/);
        expect(EVAL).toMatch(/auditPeriodEnd/);
        expect(EVAL).toMatch(/'EXPIRED'/);
    });

    it('an expired attestation forces the vendor into reassessment-due + records the trigger', () => {
        expect(USECASE).toMatch(/attestationStatus/);
        // flips the assessment stale: nextReviewAt is set to `now`.
        expect(USECASE).toMatch(/vendor\.update\(\{[\s\S]*?nextReviewAt:\s*now/);
        expect(USECASE).toMatch(/reassessmentTriggered/);
        expect(USECASE).toMatch(/REASSESSMENT_TRIGGERED/);
    });

    it('reuses the existing reassessment reminder rather than reimplementing the cadence', () => {
        expect(JOB).toMatch(/runVendorReassessmentReminder/);
    });
});

describe('vendor-monitoring — breach → finding (explicit + idempotent) + notify', () => {
    it('materialises a vendor Finding via createFinding with a VENDOR_ provenance tag', () => {
        expect(USECASE).toMatch(/VENDOR_BREACH_KIND\s*=\s*'VENDOR_BREACH'/);
        expect(USECASE).toMatch(/VENDOR_ATTESTATION_EXPIRED_KIND\s*=\s*'VENDOR_ATTESTATION_EXPIRED'/);
        expect(USECASE).toMatch(/createFinding\(/);
        expect(USECASE).toMatch(/sourceKind:/);
        expect(USECASE).toMatch(/sourceRef:/);
    });

    it('finding materialisation is EXPLICIT opt-in (materializeFindings), not automatic', () => {
        expect(VENDOR_SCHEMA).toMatch(/materializeFindings\s+Boolean\s+@default\(false\)/);
        expect(USECASE).toMatch(/if\s*\(monitor\.materializeFindings\)/);
    });

    it('findings are idempotent by (sourceKind, sourceRef); events by fingerprint', () => {
        expect(USECASE).toMatch(/findingBySourceRef\.has\(/);
        expect(USECASE).toMatch(/skipDuplicates:\s*true/);
    });

    it('notifies the vendor owner of genuine posture changes (deduped)', () => {
        expect(USECASE).toMatch(/notification\.createMany/);
        expect(USECASE).toMatch(/VENDOR_POSTURE_ALERT/);
        expect(USECASE).toMatch(/dedupeKey:/);
    });
});

describe('vendor-monitoring — external signals ride the shared seam', () => {
    it('providers fetch through the shared fetchWithRetry helper, not raw fetch', () => {
        expect(BREACH).toMatch(/from '@\/lib\/http\/fetch-with-retry'/);
        expect(TLS).toMatch(/from '@\/lib\/http\/fetch-with-retry'/);
        // The real providers call fetchWithRetry (the shared HTTP seam).
        expect(BREACH).toMatch(/fetchWithRetry\(/);
        expect(TLS).toMatch(/fetchWithRetry\(/);
    });

    it('every provider ships a deterministic, network-free stub (CI-safe default)', () => {
        expect(BREACH).toMatch(/class TestModeBreachProvider/);
        expect(TLS).toMatch(/class TestModeTlsProvider/);
        expect(BREACH).toMatch(/export function getBreachProvider/);
        expect(TLS).toMatch(/export function getTlsProvider/);
    });

    it('the job carries a kill-switch for air-gapped deployments', () => {
        expect(JOB).toMatch(/VENDOR_MONITOR_ENABLED/);
    });
});
