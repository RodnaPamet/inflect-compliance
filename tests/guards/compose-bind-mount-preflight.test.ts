/**
 * The bind-mount preflight refuses what Docker accepts — #3965.
 *
 * The failure being guarded: a bind mount whose source is missing does not
 * fail. Docker creates an empty DIRECTORY at the source and mounts it, so the
 * service starts and finds a directory where its key should be. `pipelock`'s
 * Ed25519 private key is mounted exactly that way.
 *
 * #3965's acceptance is "a test starts the service with a directory at the key
 * path and asserts it refuses to start — the input that the existence check
 * passes". The service is a third-party image we cannot make refuse anything;
 * what we can make refuse is the step before `up`. So the directory case is
 * driven against our own preflight and the assertion is on its EXIT CODE,
 * which is what "refuses to start" means for a deploy step.
 *
 * Run as a SUBPROCESS rather than imported. The script is `.mjs` so it needs no
 * build on a deploy host, and this project's node cannot `require` an ES module
 * — but spawning it also tests the thing that actually runs, exit code
 * included, instead of a function the CLI happens to call.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../scripts/preflight-compose-mounts.mjs');
const OVERLAY = path.resolve(__dirname, '../../deploy/docker-compose.pipelock.yml');

const COMPOSE = `services:
  svc:
    image: example:1
    volumes:
      - ./secret.key:/run/secrets/secret.key:ro
      - ./conf:/etc/conf:ro
      - named-vol:/var/lib/data
`;

function run(composeFile: string, base: string) {
    const r = spawnSync(process.execPath, [SCRIPT, composeFile, '--base', base], {
        encoding: 'utf-8',
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

let dir: string;
let composeFile: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mountpf-'));
    composeFile = path.join(dir, 'compose.yml');
    fs.writeFileSync(composeFile, COMPOSE);
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('the preflight refuses a DIRECTORY where a file belongs', () => {
    it('exits non-zero on the input an existence check passes', () => {
        // THE case #3965 names: the path exists, so `existsSync` is true and a
        // naive check is satisfied, yet the key is not there.
        fs.mkdirSync(path.join(dir, 'secret.key'));
        fs.mkdirSync(path.join(dir, 'conf'));
        expect(fs.existsSync(path.join(dir, 'secret.key'))).toBe(true);

        const { code, out } = run(composeFile, dir);
        expect(code).toBe(1);
        expect(out).toContain('DIRECTORY where a file belongs');
        expect(out).toContain('./secret.key');
    });
});

describe('the preflight refuses a MISSING source', () => {
    it('exits non-zero and names what Docker would have done', () => {
        fs.mkdirSync(path.join(dir, 'conf'));
        const { code, out } = run(composeFile, dir);
        expect(code).toBe(1);
        expect(out).toContain('MISSING bind-mount source');
        expect(out).toContain('EMPTY DIRECTORY');
    });
});

describe('a correct layout passes — the control that makes the refusals mean something', () => {
    it('exits zero for a real file and a real directory', () => {
        fs.writeFileSync(path.join(dir, 'secret.key'), 'key-material');
        fs.mkdirSync(path.join(dir, 'conf'));
        const { code, out } = run(composeFile, dir);
        expect(code).toBe(0);
        expect(out).toContain('preflight passed');
    });

    it('does NOT reject a directory mount for being a directory', () => {
        // If the file-shaped rule fired on `./conf` the check would refuse
        // every correct stack, and the first thing anyone did would be to
        // delete it.
        fs.writeFileSync(path.join(dir, 'secret.key'), 'key-material');
        fs.mkdirSync(path.join(dir, 'conf'));
        const { out } = run(composeFile, dir);
        expect(out).not.toContain('./conf');
    });

    it('states its own denominator, including what it skipped', () => {
        fs.writeFileSync(path.join(dir, 'secret.key'), 'key-material');
        fs.mkdirSync(path.join(dir, 'conf'));
        const { out } = run(composeFile, dir);
        // "0 checked" alone reads as "nothing to look at" when it can equally
        // mean "everything found was a problem", so the total is printed too.
        expect(out).toMatch(/3 bind mount\(s\) — 2 ok, 0 problem\(s\), 1 skipped/);
    });
});

describe('the pipelock overlay is the real instance of this failure', () => {
    it('is refused on a host that has not been prepared', () => {
        const { code, out } = run(OVERLAY, dir);
        expect(code).toBe(1);
        expect(out).toContain('./pipelock-signing.key');
    });

    it('passes once the key is actually a file', () => {
        fs.writeFileSync(path.join(dir, 'pipelock-signing.key'), 'ed25519');
        const { code } = run(OVERLAY, dir);
        expect(code).toBe(0);
    });
});
