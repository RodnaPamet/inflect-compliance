/**
 * `scripts/raise-coverage-floors.mjs` — the release step that raises the
 * verification-population floors.
 *
 * It runs as semantic-release's prepare step, so it is exercised here the way
 * the release runs it: as a real Node process, from the root of a tree, not
 * through ts-jest. Each case builds a small tree in a temp directory.
 *
 * What it must do:
 *   - raise each floor to its live count, and write nothing when none moved;
 *   - never lower a floor, which would let a release spend the very
 *     regression the guard exists to catch;
 *   - never fail: a prepare step that exits non-zero stops the release.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/raise-coverage-floors.mjs');
const FLOORS = 'tests/guards/coverage-floors.json';

let root: string;

function tree(counts: { rendered: number; e2e: number; registry: number }, floors: unknown) {
    fs.mkdirSync(path.join(root, 'tests/rendered'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests/e2e'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests/guards'), { recursive: true });
    for (let i = 0; i < counts.rendered; i++) fs.writeFileSync(path.join(root, `tests/rendered/t${i}.test.tsx`), '');
    // Not counted: the counter matches the suffix the guard counts, nothing else.
    fs.writeFileSync(path.join(root, 'tests/rendered/helper.tsx'), '');
    for (let i = 0; i < counts.e2e; i++) fs.writeFileSync(path.join(root, `tests/e2e/s${i}.spec.ts`), '');
    fs.writeFileSync(
        path.join(root, 'tests/guards/behavioural-coverage-registry.test.ts'),
        Array.from({ length: counts.registry }, (_, i) => `{ primitive: 'p${i}' },`).join('\n'),
    );
    if (floors !== undefined) {
        fs.writeFileSync(path.join(root, FLOORS), typeof floors === 'string' ? floors : JSON.stringify(floors));
    }
}

function run() {
    return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
}

const floorsOnDisk = () => JSON.parse(fs.readFileSync(path.join(root, FLOORS), 'utf8'));

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-floors-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('raise-coverage-floors', () => {
    it('raises each floor to its live count', () => {
        tree({ rendered: 5, e2e: 3, registry: 2 }, { rendered: 2, e2e: 3, registry: 1 });
        const res = run();
        expect(res.status).toBe(0);
        expect(floorsOnDisk()).toEqual({ rendered: 5, e2e: 3, registry: 2 });
        expect(res.stdout).toContain('rendered 2 → 5');
        expect(res.stdout).toContain('registry 1 → 2');
    });

    it('never lowers a floor', () => {
        tree({ rendered: 1, e2e: 1, registry: 1 }, { rendered: 4, e2e: 4, registry: 4 });
        expect(run().status).toBe(0);
        expect(floorsOnDisk()).toEqual({ rendered: 4, e2e: 4, registry: 4 });
    });

    it('leaves the file byte for byte when nothing moved', () => {
        const stored = '{ "rendered": 3, "e2e": 2, "registry": 1 }';
        tree({ rendered: 3, e2e: 2, registry: 1 }, stored);
        const res = run();
        expect(res.status).toBe(0);
        expect(fs.readFileSync(path.join(root, FLOORS), 'utf8')).toBe(stored);
        expect(res.stdout).toContain('unchanged');
    });

    it('exits 0 with a warning when it cannot read the floors, so the release goes on', () => {
        tree({ rendered: 3, e2e: 2, registry: 1 }, undefined);
        const missing = run();
        expect(missing.status).toBe(0);
        expect(missing.stderr).toContain('[coverage-floors] left unchanged');
        expect(fs.existsSync(path.join(root, FLOORS))).toBe(false);

        fs.writeFileSync(path.join(root, FLOORS), '{ not json');
        const corrupt = run();
        expect(corrupt.status).toBe(0);
        expect(fs.readFileSync(path.join(root, FLOORS), 'utf8')).toBe('{ not json');
    });
});
