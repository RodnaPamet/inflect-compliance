/**
 * Structural ratchet — data-residency foundation.
 *
 * Locks the foundation layer (schema attribute + provision-time gating +
 * doc) so it can't silently regress, and — critically — enforces that
 * every declarable region is either operationally provisioned OR has a
 * documented provisioning plan. A future `TenantRegion` enum value added
 * WITHOUT a plan (i.e. a region customers could be assigned to with no
 * infrastructure) fails CI here.
 *
 * See docs/data-residency.md.
 */
import fs from 'fs';
import path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a commented-out region or a
// prose mention cannot satisfy an assertion about code. The markdown doc is
// read raw — there prose IS the subject.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return '';
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

const enums = read('prisma/schema/enums.prisma');
const authSchema = read('prisma/schema/auth.prisma');
const regionsLib = read('src/lib/regions.ts');
const tenantLifecycle = read('src/app-layer/usecases/tenant-lifecycle.ts');
const doc = read('docs/data-residency.md');

describe('data-residency schema', () => {
    it('defines the TenantRegion enum', () => {
        expect(enums).toMatch(/enum\s+TenantRegion\s*\{/);
    });

    it('Tenant carries a region column of type TenantRegion, indexed', () => {
        expect(authSchema).toMatch(/region\s+TenantRegion\s+@default\(US_EAST_1\)/);
        expect(authSchema).toMatch(/@@index\(\[region\]\)/);
    });
});

describe('provisioning gates region', () => {
    it('regions.ts exports OPERATIONALLY_PROVISIONED_REGIONS + an assert', () => {
        expect(regionsLib).toMatch(/export const OPERATIONALLY_PROVISIONED_REGIONS/);
        expect(regionsLib).toMatch(/export function assertProvisionedRegion/);
    });

    it('createTenantWithOwner threads region and refuses un-provisioned regions', () => {
        expect(tenantLifecycle).toMatch(/region\?\s*:\s*TenantRegion/); // input field
        expect(tenantLifecycle).toMatch(/assertProvisionedRegion\(/); // refusal
        expect(tenantLifecycle).toMatch(/TENANT_REGION_SET/); // audit artifact
    });
});

describe('every declarable region is provisioned or planned', () => {
    it('no TenantRegion enum value lacks a provisioning plan', () => {
        // Enum members from the schema.
        const block = enums.match(/enum\s+TenantRegion\s*\{([\s\S]*?)\}/)?.[1] ?? '';
        const members = block
            .split('\n')
            .map((l) => l.replace(/\/\/.*$/, '').trim())
            .filter((l) => /^[A-Z0-9_]+$/.test(l));
        expect(members.length).toBeGreaterThanOrEqual(1);

        // Provisioned set + planned-region keys, both from regions.ts.
        const provisioned = [...regionsLib.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
        const plannedBlock = regionsLib.match(/PLANNED_REGIONS[\s\S]*?\{([\s\S]*?)\n\};/)?.[1] ?? '';
        const planned = [...plannedBlock.matchAll(/([A-Z0-9_]+)\s*:/g)].map((m) => m[1]);
        const covered = new Set([...provisioned, ...planned]);

        const uncovered = members.filter((m) => !covered.has(m));
        expect(uncovered).toEqual([]);
    });
});

describe('data-residency doc', () => {
    const REQUIRED = [
        '## What residency means today vs. tomorrow',
        "## What's in this PR (foundation)",
        "## What's NOT in this PR (follow-up)",
        '## Open questions for legal / compliance review',
    ];
    it('exists with the four foundation sections', () => {
        expect(doc.length).toBeGreaterThan(0);
        const missing = REQUIRED.filter((h) => !doc.includes(`\n${h}\n`));
        expect(missing).toEqual([]);
    });
});
