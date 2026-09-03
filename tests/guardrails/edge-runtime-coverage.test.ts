/**
 * Edge-runtime coverage + safety ratchet.
 *
 * Edge runtime saves cold-start latency on unauthenticated paths, but it
 * cannot import Node-only modules (Prisma's PG driver, the pino logger,
 * the AWS SDK, `node:*`). Next fails the BUILD if an edge route reaches a
 * Node module — this guard is the cheaper, faster pre-build check + a
 * record of the audit:
 *
 *   - the verified edge route(s) declare `runtime = 'edge'`;
 *   - the known-Node routes (PDF/processes/reports exports + the SSE
 *     stream) keep `runtime = 'nodejs'`;
 *   - the load-bearing invariant: NO route that declares `runtime = 'edge'`
 *     imports a Node-only dependency. A future edge route that pulls in
 *     Prisma/logger/etc. fails here before it ever fails the build.
 *
 * See docs/implementation-notes/2026-06-26-edge-runtime.md for the full
 * eligibility audit (why health/readyz/telemetry/no-tenant stay Node).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(ROOT, 'src/app/api');
// Comments masked at the seam: a commented-out `runtime = 'edge'` (or a
// commented-out node-only import) must not decide either assertion below.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const EDGE_ROUTES = ['src/app/api/csp-report/route.ts'];
const NODE_ROUTES = [
    'src/app/api/notifications/stream/route.ts',
    'src/app/api/t/[tenantSlug]/policies/[id]/export/route.ts',
    'src/app/api/t/[tenantSlug]/processes/[id]/export-pdf/route.ts',
    'src/app/api/t/[tenantSlug]/reports/pdf/generate/route.ts',
];

// Node-only deps an edge route must never import (transitively pulls a
// Node runtime: PG driver, pino worker-thread, AWS SDK, node: builtins).
const NODE_ONLY_IMPORT = /from\s+['"](@\/lib\/prisma|@\/lib\/db-context|@\/lib\/observability\/logger|@aws-sdk\/|node:|@prisma\/)/;
const DECLARES_EDGE = /export\s+const\s+runtime\s*=\s*['"]edge['"]/;
const DECLARES_NODE = /export\s+const\s+runtime\s*=\s*['"]nodejs['"]/;

function routeFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) routeFiles(abs, out);
        else if (e.name === 'route.ts' || e.name === 'route.tsx') out.push(abs);
    }
    return out;
}

describe('edge-runtime coverage', () => {
    it('the verified edge route declares runtime = edge', () => {
        for (const r of EDGE_ROUTES) {
            expect(exists(r)).toBe(true);
            expect(DECLARES_EDGE.test(read(r))).toBe(true);
        }
    });

    it('the known-Node routes keep runtime = nodejs', () => {
        for (const r of NODE_ROUTES) {
            expect(exists(r)).toBe(true);
            expect(DECLARES_NODE.test(read(r))).toBe(true);
        }
    });

    it('NO edge route imports a Node-only dependency (the load-bearing invariant)', () => {
        const offenders: string[] = [];
        for (const abs of routeFiles(API_DIR)) {
            const src = codeOf(fs.readFileSync(abs, 'utf8'));
            if (!DECLARES_EDGE.test(src)) continue;
            if (NODE_ONLY_IMPORT.test(src)) {
                offenders.push(path.relative(ROOT, abs));
            }
        }
        expect(offenders).toEqual([]);
    });
});
