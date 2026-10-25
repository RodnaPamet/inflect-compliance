/**
 * `countCoverageAt` / `readFloorsAt` — the coverage populations and floors of a
 * COMMIT, read through git (`scripts/lib/coverage-floors.js`).
 *
 * `tests/guards/rendered-coverage-floor.test.ts` refuses a change that has
 * fewer tests than its base, so the count at the base must follow exactly the
 * rules the live count follows: direct children of the folder only, by
 * suffix, and the registry's `primitive: '` entries. Each case builds a small
 * repository in a temp directory and commits a tree it then changes.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { countCoverage, countCoverageAt, readFloorsAt } = require('../../scripts/lib/coverage-floors.js');

let root: string;

const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

function write(rel: string, body = '') {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
}

function tree(counts: { rendered: number; e2e: number; registry: number }) {
    for (let i = 0; i < counts.rendered; i++) write(`tests/rendered/t${i}.test.tsx`);
    for (let i = 0; i < counts.e2e; i++) write(`tests/e2e/s${i}.spec.ts`);
    write(
        'tests/guards/behavioural-coverage-registry.test.ts',
        Array.from({ length: counts.registry }, (_, i) => `{ primitive: 'p${i}' },`).join('\n'),
    );
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-floors-at-'));
    git('init', '-q');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('countCoverageAt', () => {
    it('counts a commit the way countCoverage counts the tree', () => {
        tree({ rendered: 3, e2e: 2, registry: 4 });
        // Not counted by either: a helper, a nested folder's test, a near-miss suffix.
        write('tests/rendered/helper.tsx');
        write('tests/rendered/nested/deep.test.tsx');
        write('tests/e2e/fixtures.ts');
        git('add', '-A');
        git('commit', '-qm', 'base');
        expect(countCoverageAt(root, 'HEAD')).toEqual({ rendered: 3, e2e: 2, registry: 4 });
        expect(countCoverageAt(root, 'HEAD')).toEqual(countCoverage(root));
    });

    it('reads the commit named, not the working tree', () => {
        tree({ rendered: 3, e2e: 1, registry: 1 });
        git('add', '-A');
        git('commit', '-qm', 'base');
        fs.rmSync(path.join(root, 'tests/rendered/t0.test.tsx'));
        write('tests/e2e/extra.spec.ts');
        expect(countCoverageAt(root, 'HEAD')).toEqual({ rendered: 3, e2e: 1, registry: 1 });
        expect(countCoverage(root)).toEqual({ rendered: 2, e2e: 2, registry: 1 });
    });

    it('reads an earlier commit by its revision', () => {
        tree({ rendered: 2, e2e: 1, registry: 1 });
        git('add', '-A');
        git('commit', '-qm', 'first');
        write('tests/rendered/t9.test.tsx');
        git('add', '-A');
        git('commit', '-qm', 'second');
        expect(countCoverageAt(root, 'HEAD^1').rendered).toBe(2);
        expect(countCoverageAt(root, 'HEAD').rendered).toBe(3);
    });

    it('throws for a revision the repository does not have, rather than counting zero', () => {
        tree({ rendered: 1, e2e: 1, registry: 1 });
        git('add', '-A');
        git('commit', '-qm', 'only');
        expect(() => countCoverageAt(root, 'HEAD^1')).toThrow();
    });
});

describe('readFloorsAt', () => {
    it('reads the floors file of the commit named', () => {
        tree({ rendered: 1, e2e: 1, registry: 1 });
        write('tests/guards/coverage-floors.json', JSON.stringify({ rendered: 5, e2e: 2, registry: 1 }));
        git('add', '-A');
        git('commit', '-qm', 'base');
        write('tests/guards/coverage-floors.json', JSON.stringify({ rendered: 9, e2e: 9, registry: 9 }));
        expect(readFloorsAt(root, 'HEAD')).toEqual({ rendered: 5, e2e: 2, registry: 1 });
    });

    it('is null for a commit with no floors file', () => {
        tree({ rendered: 1, e2e: 1, registry: 1 });
        git('add', '-A');
        git('commit', '-qm', 'before floors existed');
        expect(readFloorsAt(root, 'HEAD')).toBeNull();
    });
});
