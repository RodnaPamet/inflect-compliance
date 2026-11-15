/**
 * apply.sh's backup prune keeps the newest KEEP_BACKUPS per file — dotfiles
 * included (#5308).
 *
 * The prune exists, its comment says, because "each `.env.prod.bak.*` is a
 * complete credential set" (#2889). But it listed candidates with
 * `ls -1 *.bak.*`, and a shell glob does not match a leading dot, so the very
 * files it cites as its reason were never pruned.
 *
 * This runs the prune's ACTUAL shell text, not a copy of it: the block from
 * `KEEP_BACKUPS=` to the end of its `ssh_vm` call is cut out of apply.sh and
 * run with `ssh_vm` and `sudo` stubbed to run locally, against a scratch
 * directory standing in for /opt/inflect.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APPLY = path.resolve(__dirname, '../../deploy/apply.sh');

/** The prune block, from the KEEP_BACKUPS assignment to the closing `'"`. */
function pruneBlock(): string {
    const lines = fs.readFileSync(APPLY, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('KEEP_BACKUPS='));
    if (start < 0) throw new Error('KEEP_BACKUPS= not found in apply.sh');
    const end = lines.findIndex((l, i) => i > start && l === `'"`);
    if (end < 0) throw new Error('end of the prune ssh_vm call not found in apply.sh');
    return lines.slice(start, end + 1).join('\n');
}

function runPrune(dir: string, keep: number): void {
    const script = [
        'set -euo pipefail',
        'log() { :; }',
        'sudo() { "$@"; }',
        'export -f sudo',
        // apply.sh's ssh_vm runs its one argument on the VM; here, locally.
        'ssh_vm() { bash -c "$1"; }',
        `REMOTE_DIR=${JSON.stringify(dir)}`,
        `KEEP_BACKUPS=${keep}`,
        pruneBlock(),
    ].join('\n');
    execFileSync('bash', ['-c', script], { stdio: 'pipe' });
}

/** Create `count` backups of `base`, oldest first, with distinct mtimes. */
function seed(dir: string, base: string, count: number): string[] {
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        const name = `${base}.bak.2026110${i}T000000`;
        const file = path.join(dir, name);
        fs.writeFileSync(file, `copy ${i}\n`);
        const t = new Date(Date.UTC(2026, 10, 1 + i));
        fs.utimesSync(file, t, t);
        names.push(name);
    }
    return names;
}

describe('apply.sh backup prune', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-prune-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('prunes a dotfile backup (.env.prod.bak.*) down to the newest KEEP_BACKUPS', () => {
        const env = seed(dir, '.env.prod', 7);
        runPrune(dir, 5);
        const left = fs.readdirSync(dir).filter((f) => f.startsWith('.env.prod.bak.')).sort();
        expect(left).toEqual(env.slice(2).sort());
    });

    it('still prunes ordinary backups, and keeps each file\'s own newest set', () => {
        const compose = seed(dir, 'docker-compose.prod.yml', 7);
        const roles = seed(dir, 'init-roles.sh', 3);
        runPrune(dir, 5);
        const left = fs.readdirSync(dir).sort();
        expect(left).toEqual([...compose.slice(2), ...roles].sort());
    });

    it('leaves live files alone', () => {
        fs.writeFileSync(path.join(dir, '.env.prod'), 'live\n');
        fs.writeFileSync(path.join(dir, 'docker-compose.prod.yml'), 'live\n');
        seed(dir, '.env.prod', 6);
        runPrune(dir, 5);
        expect(fs.existsSync(path.join(dir, '.env.prod'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'docker-compose.prod.yml'))).toBe(true);
    });
});
