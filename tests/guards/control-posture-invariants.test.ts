/**
 * R2-P1 — control posture correctness invariants (structural ratchet).
 *
 * Two data-model / vocabulary fractures silently broke control posture:
 *
 *  (a) ONE link model. The template-library install path wrote
 *      `frameworkMapping` rows that no posture surface reads, while the
 *      framework install wizard + SoA + coverage all use
 *      `controlRequirementLink`. Both install paths must now write the SAME
 *      canonical table, or template-installed controls silently render as
 *      unmapped in every framework's coverage/readiness.
 *
 *  (b) ONE status vocabulary. The ISO SoA rollup and the per-framework
 *      coverage/readiness rollup must recognise the IDENTICAL canonical
 *      control-status set (all 7 Prisma `ControlStatus` members) via the
 *      shared helper, so no status (PLANNED / IMPLEMENTING) is silently
 *      dropped from any framework's posture rollup.
 *
 * These are source-structure assertions — cheap, no DB — so a future refactor
 * that reintroduces either fracture fails CI in the same PR.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CANONICAL_CONTROL_STATUSES,
    STATUS_ORDER,
} from '@/lib/compliance/requirement-status-rollup';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const TEMPLATES = 'src/app-layer/usecases/control/mappings.ts';
const INSTALL = 'src/app-layer/usecases/framework/install.ts';
const SOA = 'src/app-layer/usecases/soa.ts';
const COVERAGE = 'src/app-layer/usecases/framework/coverage.ts';
const ENUMS = 'prisma/schema/enums.prisma';
const ROLLUP_MODULE = '@/lib/compliance/requirement-status-rollup';

describe('(a) ONE control↔requirement link model', () => {
    it('the template-library install path writes controlRequirementLink, not frameworkMapping', () => {
        const src = read(TEMPLATES);
        expect(src).toMatch(/controlRequirementLink\.(create|upsert)/);
        // No writes to the legacy island from the template path.
        expect(src).not.toMatch(/frameworkMapping\.(create|upsert|update|delete)/);
    });

    it('the framework install wizard writes the same canonical table', () => {
        const src = read(INSTALL);
        expect(src).toMatch(/controlRequirementLink\.(create|upsert)/);
        expect(src).not.toMatch(/frameworkMapping\.(create|upsert)/);
    });

    it('no source file still WRITES the legacy frameworkMapping table', () => {
        // The link model is unified — every writer moved to
        // controlRequirementLink. A new frameworkMapping writer would
        // resurrect the fracture.
        const offenders: string[] = [];
        for (const rel of [TEMPLATES, INSTALL, SOA, COVERAGE]) {
            if (/frameworkMapping\.(create|upsert|update|delete|createMany)/.test(read(rel))) {
                offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('(b) ONE canonical control-status vocabulary in the shared rollup', () => {
    it('both the SoA and the framework-coverage rollups import the shared status helper', () => {
        expect(read(SOA)).toContain(ROLLUP_MODULE);
        expect(read(COVERAGE)).toContain(ROLLUP_MODULE);
    });

    it('neither rollup keeps a private STATUS_ORDER map (would diverge from the shared one)', () => {
        // The shared helper owns STATUS_ORDER; a local `const STATUS_ORDER =`
        // in either rollup is exactly the fracture this PR removed.
        expect(read(SOA)).not.toMatch(/const\s+STATUS_ORDER\s*[:=]/);
        expect(read(COVERAGE)).not.toMatch(/const\s+STATUS_ORDER\s*[:=]/);
    });

    it('the canonical status set equals the Prisma ControlStatus enum exactly', () => {
        const enumSrc = read(ENUMS);
        const m = enumSrc.match(/enum\s+ControlStatus\s*\{([^}]*)\}/);
        expect(m).toBeTruthy();
        const enumMembers = (m![1].match(/[A-Z_]+/g) || []).filter(Boolean).sort();
        const canonical = [...CANONICAL_CONTROL_STATUSES].sort();
        expect(canonical).toEqual(enumMembers);
    });

    it('STATUS_ORDER has an entry for every canonical status (none silently excluded)', () => {
        for (const s of CANONICAL_CONTROL_STATUSES) {
            expect(STATUS_ORDER[s]).toBeDefined();
        }
    });
});
