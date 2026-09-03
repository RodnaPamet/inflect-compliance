/**
 * Audit Coherence S9 (2026-05-24) — structural ratchet locking the
 * three cross-framework traceability gap closures.
 *
 *   Gap A — RequirementMapping carries `validFrom` / `validTo`
 *   columns; the repository read paths apply the
 *   `activeMappingWindow()` predicate so historical / superseded
 *   mappings never reach the resolver.
 *
 *   Gap B — `getTraceabilityGraph` pushes pagination into the DB
 *   (per-kind `take:` + a 4× linkCap multiplier) so a large tenant
 *   doesn't materialise tens of thousands of rows just to render
 *   500 nodes.
 *
 *   Gap C — `enrichWithTenantImplementations` overlays the
 *   tenant's ControlRequirementLink rows onto the gap-analysis
 *   result so the frontend stops having to re-query the link table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** Comments MASKED at the read seam (#2246) — assertions bind to code, not prose. */
const read = (rel: string) =>
    codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('Audit S9 — Cross-Framework Traceability', () => {
    describe('Gap A — temporal validity window', () => {
        const schema = readPrismaSchema();
        const repo = read(
            'src/app-layer/repositories/RequirementMappingRepository.ts',
        );

        it('schema declares validFrom (default now) and nullable validTo', () => {
            // Pull the RequirementMapping model block out. The models moved to
            // separate files (2026-07-10 schema split) so the old
            // slice-between-two-models approach no longer works on the
            // whole-folder concatenation — match the single model block instead.
            // The trailing space before `{` avoids matching `RequirementMappingSet`.
            const block = schema.match(/model RequirementMapping \{[\s\S]*?\n\}/)?.[0] ?? '';
            expect(block).toMatch(
                /validFrom\s+DateTime\s+@default\(now\(\)\)/,
            );
            expect(block).toMatch(/validTo\s+DateTime\?/);
            expect(block).toMatch(/@@index\(\[validTo\]\)/);
        });

        it('migration SQL backfills validFrom from createdAt', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524160000_audit_s9_mapping_validity',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = codeOf(
                fs.readFileSync(path.join(migDir, 'migration.sql'), 'utf8'),
            );
            expect(sql).toMatch(
                /ADD COLUMN IF NOT EXISTS "validFrom"\s+TIMESTAMP/i,
            );
            expect(sql).toMatch(
                /ADD COLUMN IF NOT EXISTS "validTo"\s+TIMESTAMP/i,
            );
            expect(sql).toMatch(
                /SET "validFrom"\s*=\s*COALESCE\("validFrom",\s*"createdAt"\)/,
            );
            expect(sql).toMatch(
                /ALTER COLUMN "validFrom" SET NOT NULL/,
            );
        });

        it('repository exposes `activeMappingWindow` helper', () => {
            expect(repo).toMatch(
                /export function activeMappingWindow/,
            );
            expect(repo).toMatch(/validFrom:\s*\{\s*lte:\s*now\s*\}/);
            expect(repo).toMatch(
                /OR:\s*\[\s*\{\s*validTo:\s*null\s*\}\s*,\s*\{\s*validTo:\s*\{\s*gt:\s*now\s*\}/,
            );
        });

        it('all three findBy* read paths apply the active-window predicate', () => {
            // findBySourceRequirement / findByFrameworkPair /
            // findByTargetRequirement.
            const occurrences =
                repo.match(/\.\.\.activeMappingWindow\(\)/g) ?? [];
            expect(occurrences.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('Gap B — getTraceabilityGraph pushes pagination into the DB', () => {
        const src = read(
            'src/app-layer/usecases/traceability-graph.ts',
        );

        it('declares LINK_CAP_MULTIPLIER and derives nodeCap / linkCap', () => {
            expect(src).toMatch(
                /const LINK_CAP_MULTIPLIER\s*=\s*\d+/,
            );
            expect(src).toMatch(
                /const nodeCap\s*=\s*options\.nodeCap\s*\?\?\s*DEFAULT_NODE_CAP/,
            );
            expect(src).toMatch(
                /const linkCap\s*=\s*nodeCap\s*\*\s*LINK_CAP_MULTIPLIER/,
            );
        });

        it('control / risk / asset findMany calls all carry take: nodeCap', () => {
            // Ten findMany calls in the usecase — five entity
            // (control / risk / asset / requirement / policy) + five link
            // (riskControl / controlAsset / assetRiskLink /
            // controlRequirementLink / policyControlLink). Each must carry a
            // `take:` literal. The structural detector confirms the absence
            // of any bare findMany. (Policy was added in PR-Y — the graph now
            // draws control→policy `governs` edges.)
            const findManyCount = (src.match(/\.findMany\(/g) ?? []).length;
            expect(findManyCount).toBe(10);
            const takeCount = (src.match(/take:\s*(nodeCap|linkCap)/g) ?? []).length;
            expect(takeCount).toBe(10);
        });
    });

    describe('Gap C — tenant control-implementation overlay', () => {
        const src = read(
            'src/app-layer/services/cross-framework-traceability.ts',
        );

        it('exports the overlay types + function', () => {
            expect(src).toMatch(
                /export interface TenantControlImplementation/,
            );
            expect(src).toMatch(
                /export interface GapAnalysisEntryWithImplementations/,
            );
            expect(src).toMatch(
                /export interface GapAnalysisResultWithImplementations/,
            );
            expect(src).toMatch(
                /export function enrichWithTenantImplementations/,
            );
        });

        it('overlay is a pure function — does not query Prisma inside its body', () => {
            // The caller owns the DB query; the service stays
            // dependency-free for unit testing.
            const fnStart = src.indexOf('export function enrichWithTenantImplementations');
            const fnBody = src.slice(fnStart, fnStart + 800);
            expect(fnBody).not.toMatch(/\bprisma\./);
            expect(fnBody).not.toMatch(/\bdb\.controlRequirementLink/);
            expect(fnBody).not.toMatch(/\.findMany\(/);
        });

        it('overlay builds a per-requirement lookup before mapping entries', () => {
            const block = src.slice(
                src.indexOf('export function enrichWithTenantImplementations'),
            );
            expect(block).toMatch(/new Map<string,\s*TenantControlImplementation/);
            expect(block).toMatch(/byReq\.get\(e\.targetRequirement\.requirementId\)/);
        });
    });
});
