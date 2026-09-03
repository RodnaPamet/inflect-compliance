/**
 * Structural ratchet — read-replica routing.
 *
 * Locks the primary/replica split:
 *   - the two clients (`prisma` + `prismaRead`) + the `runInTenantReadContext`
 *     helper exist,
 *   - the dashboard/aggregation usecases route through `runInTenantReadContext`,
 *   - NO write happens inside a read-context callback (the read-after-write
 *     safety rule — scoped to the callback, since these usecase files also
 *     legitimately contain write functions).
 *
 * See docs/database-routing.md.
 */
import fs from 'fs';
import path from 'path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246): a comment mentioning
// `runInTenantReadContext(` must not satisfy the routing assertions below,
// and a write token inside a comment must not read as a write.
const read = (rel: string) =>
    fs.existsSync(path.join(ROOT, rel))
        ? codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
        : '';

const WRITE_TOKENS = [
    '.create(',
    '.createMany(',
    '.update(',
    '.updateMany(',
    '.delete(',
    '.deleteMany(',
    '.upsert(',
    'logEvent(',
    'appendAuditEntry(',
];

/**
 * Extract every `runInTenantReadContext( ... )` call's argument list by
 * balanced-paren matching, so the write-safety check is scoped to the
 * read callback — not the whole file.
 */
function readContextCallArgs(src: string): string[] {
    const out: string[] = [];
    const marker = 'runInTenantReadContext(';
    let i = src.indexOf(marker);
    while (i !== -1) {
        let depth = 0;
        let start = i + marker.length - 1; // at the '('
        let j = start;
        for (; j < src.length; j++) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        out.push(src.slice(start + 1, j));
        i = src.indexOf(marker, j);
    }
    return out;
}

// Usecase files the dashboard/aggregation reads route through.
const ROUTED_USECASES = [
    // The Controls replica read is the tenant-wide dashboard aggregate, which
    // moved out of ./queries into ./dashboard (roadmap P3.3). ./queries now
    // holds only per-request list/detail reads — none of them replica-routed.
    'src/app-layer/usecases/control/dashboard.ts',
    'src/app-layer/usecases/vendor.ts',
    'src/app-layer/usecases/task.ts',
    'src/app-layer/usecases/loss-event.ts',
    'src/app-layer/usecases/due-planning.ts',
    'src/app-layer/usecases/test-scheduling.ts',
];

describe('read-replica clients + helper', () => {
    const prismaSrc = read('src/lib/prisma.ts');
    const ctxSrc = read('src/lib/db-context.ts');

    it('prisma.ts exports a prismaRead client', () => {
        expect(prismaSrc).toMatch(/export const prismaRead/);
    });

    it('db-context.ts exports runInTenantReadContext with a READ ONLY transaction', () => {
        expect(ctxSrc).toMatch(/export async function runInTenantReadContext/);
        expect(ctxSrc).toContain('SET TRANSACTION READ ONLY');
    });
});

describe('dashboard/aggregation usecases route to the replica', () => {
    it.each(ROUTED_USECASES)('%s uses runInTenantReadContext', (rel) => {
        const src = read(rel);
        expect(src.length).toBeGreaterThan(0);
        expect(src).toContain('runInTenantReadContext(');
    });
});

describe('read-after-write safety', () => {
    it.each(ROUTED_USECASES)('%s performs no write inside a read context', (rel) => {
        const src = read(rel);
        for (const args of readContextCallArgs(src)) {
            for (const tok of WRITE_TOKENS) {
                expect({ file: rel, token: tok, inReadContext: args.includes(tok) }).toEqual({
                    file: rel,
                    token: tok,
                    inReadContext: false,
                });
            }
        }
    });
});
