/**
 * Every Prisma client outside the tests is built with a driver adapter (#5242).
 *
 * Prisma 7 removed the built-in engine's connection handling: a client
 * constructed with no `adapter` throws `PrismaClientInitializationError` on
 * its first query. Thirteen operator and seed scripts still called
 * `new PrismaClient()`, so the DEK backfill, the encryption backfills, the
 * tenant-owner bootstrap and the file migration all failed before doing any
 * work, and each was a documented runbook step.
 *
 * Scope: everything git tracks except `tests/` (whose clients are held by the
 * `require-test-prisma-transaction-budget` lint rule and the test helpers)
 * and the ESLint rule fixtures, which spell the call in strings on purpose.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const OUT_OF_SCOPE = /^(tests|eslint-rules|scratch)\//;

/** A `new PrismaClient(` call whose argument list never names `adapter`. */
function adapterlessCalls(raw: string): number {
    // Comments masked, so prose naming the call is not a call.
    const src = codeOf(raw);
    let count = 0;
    const re = /new PrismaClient\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        // Read to the matching close paren.
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < src.length && depth > 0; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') depth--;
        }
        if (!/\badapter\b/.test(src.slice(m.index, i))) count++;
    }
    return count;
}

describe('Prisma clients outside tests carry a driver adapter (#5242)', () => {
    const files = repoRelativeFiles().filter((f) => CODE.test(f) && !OUT_OF_SCOPE.test(f));

    it('reads the population (positive control)', () => {
        const constructing = files.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('new PrismaClient('));
        expect(constructing.length).toBeGreaterThanOrEqual(15);
    });

    it('no file builds a client without one', () => {
        const offenders = files.filter((f) => adapterlessCalls(fs.readFileSync(path.join(ROOT, f), 'utf8')) > 0);
        expect(offenders).toEqual([]);
    });

    it.each([
        ['new PrismaClient()', 1],
        ["new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })", 0],
        ['new PrismaClient({ log: ["warn"] })', 1],
        ['new PrismaClient({\n  adapter,\n  log: f(x),\n})', 0],
        ['// `new PrismaClient()` needs an adapter\nconst x = 1;', 0],
    ])('the detector: %s → %d', (src, expected) => {
        expect(adapterlessCalls(src)).toBe(expected);
    });
});
