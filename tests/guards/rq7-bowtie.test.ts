/**
 * RQ-7 ratchet — bow-tie projection stays wired: the pure projection +
 * xyflow conversion (NO schema — read-time projection), the route, and the
 * Bow-Tie tab on the risk detail page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('RQ-7 bow-tie', () => {
    it('the projection service is pure (no Prisma model added) + exposes build + xyflow', () => {
        const src = read('src/app-layer/usecases/bowtie-projection.ts');
        expect(src).toMatch(/export function buildBowTie/);
        expect(src).toMatch(/export function toXyFlowGraph/);
        expect(src).toMatch(/export async function projectBowTie/);
        // barrier classification by mitigationType
        expect(src).toMatch(/PREVENTIVE/);
        expect(src).toMatch(/DETECTIVE/);
        // RQ-7 adds NO new model — it's a read projection.
        expect(codeOf(readPrismaSchema())).not.toMatch(/model BowTie/);
    });

    it('the route + panel + tab exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/[id]/bowtie/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTiePanel.tsx')).toBe(true);
        const page = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
        expect(page).toMatch(/BowTiePanel/);
        expect(page).toMatch(/'bowtie'/);
    });

    it('the interactive xyflow canvas is wired (the RQ-7 deferred follow-up)', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieCanvas.tsx')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieNode.tsx')).toBe(true);
        const canvas = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieCanvas.tsx');
        expect(canvas).toMatch(/@xyflow\/react/);
        expect(canvas).toMatch(/elementsSelectable=\{false\}/); // read-only projection
        expect(read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTiePanel.tsx')).toMatch(/BowTieCanvas/);
    });
});
