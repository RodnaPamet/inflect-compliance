/**
 * Issue Routes - Structural Tests
 * Ensures no Prisma imports or direct logAudit calls in route handlers.
 */
import * as fs from 'fs';
import * as path from 'path';

const ISSUE_ROUTES_DIR = path.join(process.cwd(), 'src/app/api/t/[tenantSlug]/issues');

function getAllRouteFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...getAllRouteFiles(fullPath));
        } else if (entry.name === 'route.ts') {
            files.push(fullPath);
        }
    }
    return files;
}

describe('Issue Route Structural Checks', () => {
    const routeFiles = getAllRouteFiles(ISSUE_ROUTES_DIR);

    // Three, not sixteen: the parallel `/issues` write API was retired on
    // 2026-08-11 and only the evidence-bundle routes — the ones with no
    // `/tasks` twin — survived. If this number grows, a route was added to a
    // surface that is supposed to be closed; check it is not another duplicate
    // of something `/tasks` already serves.
    it('is down to the three evidence-bundle routes', () => {
        expect(routeFiles.length).toBe(3);
    });

    routeFiles.forEach((filePath) => {
        const relativePath = path.relative(process.cwd(), filePath);

        it(`${relativePath} should not import prisma directly`, () => {
            const content = fs.readFileSync(filePath, 'utf-8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).not.toMatch(/from\s+['"]\.\.\/.*prisma['"]/);
            expect(content).not.toMatch(/import.*PrismaClient/);
        });

        it(`${relativePath} should not call logAudit or logEvent directly`, () => {
            const content = fs.readFileSync(filePath, 'utf-8');
            expect(content).not.toMatch(/logAudit/);
            expect(content).not.toMatch(/logEvent/);
        });

        it(`${relativePath} should use withApiErrorHandling`, () => {
            const content = fs.readFileSync(filePath, 'utf-8');
            expect(content).toMatch(/withApiErrorHandling/);
        });

        /**
         * The point of this assertion is that the handler runs with a resolved,
         * membership-checked `RequestContext` — NOT that it calls one specific
         * function to get one.
         *
         * `requirePermission` resolves the context itself (via `getTenantCtx`)
         * and hands it to the handler as a third argument, so a gated route
         * correctly does NOT mention `getTenantCtx`. Asserting the literal call
         * would now push every route back toward the ungated shape, which is
         * the defect these three were just fixed for.
         */
        it(`${relativePath} resolves a tenant context — gated or explicit`, () => {
            const content = fs.readFileSync(filePath, 'utf-8');
            expect(/requirePermission|getTenantCtx/.test(content)).toBe(true);
        });

        it(`${relativePath} is permission-gated`, () => {
            // The whole reason the surrounding surface was deleted: not one of
            // its sixteen routes used requirePermission, so the granular
            // custom-role `tasks.*` flags were unreachable and denials wrote no
            // AUTHZ_DENIED row.
            const content = fs.readFileSync(filePath, 'utf-8');
            expect(content).toMatch(/requirePermission/);
        });
    });
});
