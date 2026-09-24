/**
 * Structural ratchet — the BullMQ worker is actually deployed.
 *
 * REGRESSION CLASS
 * ----------------
 * The app enqueues background jobs and `schedules.ts` defines 12
 * repeatable crons (task-due reminders, evidence expiry, retention
 * sweeps, the notification digest, …). All of that depends on a
 * separate long-running process: `scripts/worker.ts` (the BullMQ
 * worker) plus `scripts/scheduler.ts` (registers the repeatables).
 *
 * For a long time NEITHER ran in any Docker Compose deployment:
 * `entrypoint.sh` started only `next start`, no Compose file had a
 * `worker` service, and the worker scripts were not even in the
 * production image. Every scheduled job silently never fired and
 * enqueued jobs piled up in Redis — while every test stayed green,
 * because nothing asserted the worker was deployed.
 *
 * This guard makes the worker's deployment non-optional:
 *   1. Every production-like Compose file has a `worker` service
 *      that runs the scheduler then the worker.
 *   2. The Dockerfile builds the worker bundle and ships it.
 *   3. `package.json` carries the `build:worker` script and the
 *      build script exists.
 *
 * Pure static analysis — reads the Compose files, Dockerfile and
 * package.json.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The production-like Compose files — each must run a worker. */
const PROD_COMPOSE_FILES = [
    'docker-compose.prod.yml',
    'deploy/docker-compose.prod.yml',
    'docker-compose.staging.yml',
];

interface ComposeService {
    command?: string | string[];
    entrypoint?: string | string[];
}
interface ComposeFile {
    services?: Record<string, ComposeService>;
}

/** Normalise a Compose `command`/`entrypoint` to a single string. */
function asText(v: string | string[] | undefined): string {
    return Array.isArray(v) ? v.join(' ') : (v ?? '');
}

describe('BullMQ worker is deployed', () => {
    describe.each(PROD_COMPOSE_FILES)('%s', (file) => {
        const compose = yaml.load(read(file)) as ComposeFile;
        const worker = compose.services?.worker;

        it('declares a `worker` service', () => {
            expect(worker).toBeDefined();
        });

        it('the worker runs the scheduler then the worker bundle', () => {
            const cmd = asText(worker?.command) + ' ' + asText(worker?.entrypoint);
            expect(cmd).toContain('dist/scheduler.mjs');
            expect(cmd).toContain('dist/worker.mjs');
        });

        it('the worker overrides the image ENTRYPOINT (not `next start`)', () => {
            // The image ENTRYPOINT is entrypoint.sh → next start. The
            // worker MUST override it, or it would run a second web
            // server instead of the worker.
            expect(worker?.entrypoint).toBeDefined();
        });
    });

    it('the Dockerfile builds the worker bundle and ships it', () => {
        const dockerfile = read('Dockerfile');
        expect(dockerfile).toMatch(/npm run build:worker/);
        expect(dockerfile).toMatch(/COPY --from=builder \/app\/dist \.\/dist/);
        // build:worker must run before the dev-dependency prune —
        // esbuild is a devDependency.
        const buildIdx = dockerfile.indexOf('build:worker');
        const pruneIdx = dockerfile.indexOf('npm prune');
        expect(buildIdx).toBeGreaterThan(-1);
        expect(buildIdx).toBeLessThan(pruneIdx);
    });

    it('package.json carries the build:worker script', () => {
        const pkg = JSON.parse(read('package.json')) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.['build:worker']).toBeDefined();
    });

    it('the worker build script exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'scripts/build-worker.mjs'))).toBe(true);
    });
});

/**
 * EXACTLY ONE COMPOSE FILE IS THE DEPLOYED ONE, AND IT SAYS SO.
 *
 * The repo carries two files named `docker-compose.prod.yml` — one at the
 * root, one under `deploy/` — and for a long time both opened by calling
 * themselves the production environment. Only the second runs anything: it is
 * what sits at `/opt/inflect/docker-compose.prod.yml` on the VM. They are not
 * interchangeable, and the differences are the dangerous kind rather than the
 * cosmetic kind: different service names, a different DATABASE NAME
 * (`inflect_production` vs the live `inflect_compliance`), and a different env
 * file (`.env.production` vs `./.env.prod`).
 *
 * The cost was measured, not imagined. An operator reading the ROOT file to
 * understand the live deployment concluded the deployed env file had drifted
 * from the repo, reported it as a finding, and was one step from writing
 * production configuration into a path nothing reads. Nothing in either file
 * contradicted that reading.
 *
 * So the role is declared in the file itself and pinned here. A third prod
 * compose, or a second one claiming to be the deployed stack, fails.
 */
describe('which compose file is the deployed one', () => {
    const roleOf = (rel: string): string | null => {
        const m = read(rel).match(/ROLE:\s*([a-z-]+)/);
        return m ? m[1] : null;
    };

    it('the root file declares itself LOCAL, not the deployed stack', () => {
        expect(roleOf('docker-compose.prod.yml')).toBe('local-production');
    });

    it('deploy/ declares itself the deployed stack', () => {
        expect(roleOf('deploy/docker-compose.prod.yml')).toBe('deployed-production');
    });

    it('exactly one file claims to be deployed', () => {
        // The claim with teeth. Two files claiming it is the state this guard
        // exists to end, and a THIRD prod compose appearing unlabelled is the
        // way the ambiguity comes back.
        const claimants = PROD_COMPOSE_FILES.filter(
            (f) => roleOf(f) === 'deployed-production',
        );
        expect({ deployed: claimants }).toEqual({
            deployed: ['deploy/docker-compose.prod.yml'],
        });
    });

    it('every production-like compose file declares a role at all', () => {
        const unlabelled = PROD_COMPOSE_FILES.filter((f) => roleOf(f) === null);
        expect({ unlabelled }).toEqual({ unlabelled: [] });
    });
});
