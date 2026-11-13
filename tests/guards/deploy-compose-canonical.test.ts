/**
 * Structural ratchet — the prod Compose file is a CANONICAL artefact, not a
 * copy of one.
 *
 * REGRESSION CLASS
 * ----------------
 * `deploy/docker-compose.prod.yml` is the source of truth for the production
 * VM's stack structure, pushed by `deploy/apply.sh` and diffed by
 * `deploy/check-drift.sh` (#2849). Before that contract the host file was
 * hand-edited and the repo file was hand-edited independently; they diverged
 * by ~148 lines, and the repo copy — the one a person reaches for during an
 * incident — was the one that had never run.
 *
 * Three properties made the repo copy un-runnable, and each is a regression
 * a well-meaning diff can reintroduce:
 *
 *   1. A credential pasted in as a LITERAL. The live file carried inlined
 *      secrets where this one interpolates; "just make the deploy go" is how
 *      that happens, and this repo is public.
 *   2. A bind mount that production needs going missing. `prisma.config.ts`
 *      was mounted live and absent here for four months.
 *   3. A service that cannot start being left in the file. `pipelock`
 *      bind-mounts a signing key that does not exist on the VM — and Docker
 *      answers a missing bind-mount source by creating an empty DIRECTORY,
 *      so nothing fails until `up`. It now lives in an opt-in overlay.
 *
 * WHY THESE ASSERTIONS AVOID `toMatch`/`toContain` ON A WHOLE-FILE READ
 * --------------------------------------------------------------------
 * Both assertion-reach ratchets (#2246) run over this file. A needle matched
 * against an entire compose file is exactly the ambiguous shape Class D
 * counts, and `DRIFT_ALLOWANCE` is 0 in both — so every assertion below
 * extracts the construct it is about first and asserts on a value, never on
 * the file's text.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { repoRelativeFiles } from '../helpers/repo-files';

const REPO_ROOT = path.resolve(__dirname, '../..');

const CANONICAL = 'deploy/docker-compose.prod.yml';
const OVERLAY = 'deploy/docker-compose.pipelock.yml';

const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** Lines with their leading `#` comments stripped — comments are prose here. */
const codeLines = (src: string): string[] =>
    src.split('\n').filter((l) => !/^\s*#/.test(l));

/** Top-level service names: the two-space-indented keys under `services:`. */
function serviceNames(src: string): string[] {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => /^services:\s*$/.test(l));
    if (start === -1) return [];
    const names: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break; // next top-level key (`volumes:`)
        const m = /^ {2}([a-z0-9_-]+):\s*$/.exec(lines[i]);
        if (m) names.push(m[1]);
    }
    return names;
}

/** One service block: its `  <name>:` line up to the next sibling/top key. */
function serviceBlock(src: string, service: string): string[] {
    const lines = src.split('\n');
    const start = lines.findIndex((l) =>
        new RegExp(`^ {2}${service}:\\s*$`).test(l),
    );
    if (start === -1) return [];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end);
}

/** The `volumes:` list entries of a service block, as raw strings. */
function volumesOf(block: string[]): string[] {
    const start = block.findIndex((l) => /^ {4}volumes:\s*$/.test(l));
    if (start === -1) return [];
    const out: string[] = [];
    for (let i = start + 1; i < block.length; i++) {
        if (/^ {4}\S/.test(block[i])) break;
        const m = /^\s*-\s+(\S+)\s*$/.exec(block[i]);
        if (m) out.push(m[1]);
    }
    return out;
}

/**
 * Every credential this file carries, and how it is expressed.
 *
 * The check is the INVERSE of a denylist: rather than trying to recognise
 * what a secret looks like, it finds every place the three known credential
 * names are USED and asserts each one is a `${...}` reference. A pasted
 * literal at any of those sites fails, whatever the literal looks like.
 */
const CREDENTIAL_NAMES = [
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
    'DATA_ENCRYPTION_KEY',
] as const;

/** Non-comment lines that use a credential name, excluding pure references. */
function credentialUseLines(src: string, name: string): string[] {
    return codeLines(src).filter((l) => l.includes(name));
}

describe('deploy/docker-compose.prod.yml — no credential is a literal', () => {
    it.each(CREDENTIAL_NAMES)(
        '%s is only ever used as a ${…} interpolation',
        (name) => {
            const uses = credentialUseLines(read(CANONICAL), name);
            // A positive control on the detector itself: if a rename made
            // this name unfindable the loop below would pass vacuously.
            expect(uses.length).toBeGreaterThan(0);
            const literalUses = uses.filter((l) => !l.includes('${'));
            expect(literalUses).toEqual([]);
        },
    );

    it('every credential carries a :? fail-fast guard', () => {
        // Comments are masked at the READ SEAM (#2246). The compose file's
        // own header explains the mechanism using a literal `${VAR:?message}`
        // example, and scanning the raw text picked it up as a guarded
        // variable named VAR — a comment satisfying an assertion that is
        // meant to be about the configuration.
        const src = codeLines(read(CANONICAL)).join('\n');
        // The set of names guarded with `:?`, derived from the file. An
        // unguarded credential is one `docker compose up` away from starting
        // a container with an empty password instead of refusing.
        const guarded = new Set(
            Array.from(src.matchAll(/\$\{([A-Z_]+):\?/g), (m) => m[1]),
        );
        expect([...guarded].sort()).toEqual([...CREDENTIAL_NAMES].sort());
    });
});

describe('deploy/docker-compose.prod.yml — redis credential handling', () => {
    /**
     * These two assert the CALL SITES rather than the variable name, and
     * that distinction was measured: replacing
     * `--requirepass "${REDIS_PASSWORD:?…}"` with a literal reddened only
     * ONE of the tests above, because a scan keyed on the name cannot see a
     * secret that removed the name. The `:?` set check caught it; the
     * "only used as an interpolation" check passed vacuously on the one
     * remaining mention. A guard needs an axis that survives the rename.
     */
    const redisCommand = (): string =>
        codeLines(read(CANONICAL)).find((l) => l.includes('redis-server')) ?? '';

    it('--requirepass takes an interpolation, never a literal', () => {
        const cmd = redisCommand();
        expect(cmd).not.toBe('');
        const arg = /--requirepass\s+("?)(.*?)\1(?:\s|$)/.exec(cmd)?.[2] ?? '';
        expect(arg.startsWith('${')).toBe(true);
    });

    it('the healthcheck does not put the credential on the command line', () => {
        // The live host file ran `redis-cli --no-auth-warning -a <secret>
        // ping`, which puts the password in `docker inspect` output — the
        // place it is most likely to be pasted into a ticket. The repo form
        // uses REDISCLI_AUTH in the environment instead, which redis-cli
        // reads on its own.
        const block = serviceBlock(read(CANONICAL), 'redis');
        const test = block.filter((l) => l.includes('redis-cli'));
        expect(test.length).toBeGreaterThan(0);
        expect(test.filter((l) => /[-]a\b|--pass/.test(l))).toEqual([]);
    });
});

describe('deploy/docker-compose.prod.yml — the deployable set is complete', () => {
    const PRISMA_MOUNT = './prisma.config.ts:/app/prisma.config.ts:ro';

    it.each(['app', 'worker'])(
        '%s mounts prisma.config.ts (Prisma 7 resolves its config at runtime)',
        (service) => {
            const block = serviceBlock(read(CANONICAL), service);
            expect(block.length).toBeGreaterThan(0);
            expect(volumesOf(block)).toContain(PRISMA_MOUNT);
        },
    );

    it('the file the compose mounts exists in the repo at the path it names', () => {
        // apply.sh pushes prisma.config.ts to /opt/inflect/ so the mount
        // resolves. A mount naming a file the repo does not have would push
        // nothing and Docker would silently mount an empty directory.
        expect(fs.existsSync(path.join(REPO_ROOT, 'prisma.config.ts'))).toBe(true);
        expect(fs.existsSync(path.join(REPO_ROOT, 'deploy/init-roles.sh'))).toBe(true);
    });
});

describe('deploy compose — pipelock stays in the opt-in overlay', () => {
    it('the canonical file defines exactly the eight services production runs', () => {
        // An EXACT list rather than a superset check, which is why adding a
        // service has to come through here: the regression this guard exists for
        // is a service that cannot start being left in the file, and `pipelock`
        // proved Docker answers a missing bind-mount by creating an empty
        // directory, so nothing fails until `up`. A new entry therefore gets
        // read by somebody.
        //
        // `laya` was added 2026-10-11 (step 6d) and REMOVED 2026-10-14, which is
        // the same scrutiny working in the other direction. It held 1.9 GiB of
        // RAM and ~5% of two vCPUs continuously while serving nothing —
        // `LegacyMatchVerdict` was 0 rows in production for its entire life,
        // because no evaluation record was ever committed and the adjudication
        // gate refuses `NO_EVALUATION`. Its Dockerfile and build workflow were
        // deleted the same day, and the root and staging stacks dropped the
        // service in #4178, so restoring it is a rebuild, not just an entry here.
        //
        // NOTE FOR WHOEVER RESTORES IT: the 6.68 GB pull is why it was named
        // here in the first place, and that cost returns with it.
        expect(serviceNames(read(CANONICAL)).sort()).toEqual([
            'app',
            'caddy',
            'clamav',
            'pgbouncer',
            'postgres',
            'redis',
            'watchtower',
            'worker',
        ]);
    });

    it('the overlay defines pipelock and nothing else', () => {
        expect(serviceNames(read(OVERLAY))).toEqual(['pipelock']);
    });

    it('the signing-key bind mount lives only in the overlay', () => {
        // It is the precondition the VM does not satisfy, and a missing
        // bind-mount source becomes an empty DIRECTORY rather than an error,
        // so its presence in the canonical file is un-runnable-by-default.
        const inOverlay = volumesOf(serviceBlock(read(OVERLAY), 'pipelock'));
        expect(inOverlay.some((v) => v.startsWith('./pipelock-signing.key'))).toBe(true);
        const canonicalVolumes = serviceNames(read(CANONICAL)).flatMap((s) =>
            volumesOf(serviceBlock(read(CANONICAL), s)),
        );
        expect(
            canonicalVolumes.filter((v) => v.includes('pipelock')),
        ).toEqual([]);
    });
});

/**
 * The harness scanner's overlay (#3665): Inflect's own estate scanned from the
 * production VM. Parsed as YAML, so each assertion is on a value the service
 * actually has rather than on the file's text.
 *
 * Each property here is one a "make it start" edit would plausibly undo, and
 * none of them fails at `up`: an `env_file` of `.env.prod` hands the scanner the
 * master encryption key; a tag instead of a digest, or a Watchtower label, lets
 * the image change underneath the pin; a dropped hardening line goes unnoticed
 * because the scanner runs the same either way.
 *
 * Since scanent #26 the image is scanent's (`ghcr.io/rodnapamet/scanent`), and
 * the paths below are its image's: the CLI's default command, the proxy at
 * `/app/packages/scanner/dist/egress-proxy.js`, the configuration at
 * `/etc/scanent`.
 */
describe('deploy compose — the harness scanner stays in its own overlay, pinned and narrowed', () => {
    const SCANNER_OVERLAY = 'deploy/docker-compose.harness-scanner.yml';
    type Service = {
        image?: string;
        user?: string;
        read_only?: boolean;
        cap_drop?: string[];
        security_opt?: string[];
        env_file?: string[];
        environment?: unknown;
        volumes?: string[];
        ports?: unknown;
        expose?: unknown;
        labels?: unknown;
        command?: string[];
        entrypoint?: string[];
        networks?: string[];
        pids_limit?: number;
    };
    const doc = yaml.load(read(SCANNER_OVERLAY)) as { services: Record<string, Service>; networks?: Record<string, unknown> };
    const svc = doc.services['harness-scanner'];
    const proxy = doc.services['harness-egress'];

    it('defines the scanner and its egress proxy, and nothing else', () => {
        // The proxy is #5004 part C: the scanner's one way out.
        expect(Object.keys(doc.services).sort()).toEqual(['harness-egress', 'harness-scanner']);
    });

    it('pins scanent\'s published image by digest', () => {
        expect(svc.image).toMatch(/^ghcr\.io\/rodnapamet\/scanent@sha256:[0-9a-f]{64}$/);
    });

    it('no longer runs the in-repo scanner\'s image', () => {
        // The previous digest is kept in a comment for the rollback; no service
        // names it.
        for (const s of Object.values(doc.services)) expect(s.image).not.toContain('agent-harness-scanner');
    });

    it('reads its own environment file, never .env.prod, and interpolates nothing', () => {
        expect(svc.env_file).toEqual(['./.env.scanner']);
        // The only literals it sets are the ones that point it at its proxy,
        // and the statement that the proxy is scanent's own, which checks the
        // address it dials: no secret, and nothing interpolated from the
        // host's env files.
        expect(svc.environment).toEqual({
            HTTPS_PROXY: 'http://harness-egress:3128',
            HTTP_PROXY: 'http://harness-egress:3128',
            NO_PROXY: '',
            NODE_USE_ENV_PROXY: '1',
            EGRESS_PROXY_CHECKS_ADDRESSES: '1',
        });
        expect(read(SCANNER_OVERLAY)).not.toContain('${');
    });

    it('sits on an internal network only; the proxy is its one neighbour with a way out', () => {
        expect(svc.networks).toEqual(['harness-scanner-internal']);
        expect(doc.networks?.['harness-scanner-internal']).toEqual({ internal: true });
        expect([...(proxy.networks ?? [])].sort()).toEqual(['harness-scanner-egress', 'harness-scanner-internal']);
    });

    it('runs the proxy from the same pinned image, as narrowly as the scanner, holding no credential', () => {
        expect(proxy.image).toBe(svc.image);
        expect(proxy.entrypoint).toEqual(['node', '/app/packages/scanner/dist/egress-proxy.js']);
        expect(proxy.command).toEqual([]);
        expect(proxy.read_only).toBe(true);
        expect(proxy.user).toBe('1000:1000');
        expect(proxy.cap_drop).toEqual(['ALL']);
        expect(proxy.security_opt).toEqual(['no-new-privileges:true']);
        expect(proxy.env_file).toBeUndefined();
        expect(proxy.volumes).toBeUndefined();
        expect(proxy.ports).toBeUndefined();
        expect(proxy.expose).toBeUndefined();
        expect(proxy.labels).toBeUndefined();
        expect(Object.keys(proxy.environment as Record<string, string>)).toEqual(['EGRESS_ALLOW']);
    });

    it('runs read-only, unprivileged, as uid 1000, with every capability dropped', () => {
        expect(svc.read_only).toBe(true);
        expect(svc.user).toBe('1000:1000');
        expect(svc.cap_drop).toEqual(['ALL']);
        expect(svc.security_opt).toEqual(['no-new-privileges:true']);
    });

    it('bounds the process count of both, as scanent\'s own template does', () => {
        expect(svc.pids_limit).toBe(256);
        expect(proxy.pids_limit).toBe(256);
    });

    it('mounts only its configuration directory, read-only', () => {
        // No writable mount: with the `inflect` output alone the scanner writes nothing.
        expect(svc.volumes).toEqual(['./harness-scanner:/etc/scanent:ro']);
    });

    it('serves nothing and is never auto-updated', () => {
        expect(svc.ports).toBeUndefined();
        expect(svc.expose).toBeUndefined();
        expect(svc.labels).toBeUndefined();
    });

    it('runs the schedule against the mounted configuration', () => {
        expect(svc.command).toEqual(['schedule', '--config', '/etc/scanent/config.json']);
    });
});

/**
 * The capacity budget (C1, 2026-11-12): every container on the production VM
 * has a memory limit and a CPU cap, and the memory limits together leave the
 * host 1.5 GB of its own.
 *
 * Before C1 no service declared either, so one container could take the whole
 * VM and the kernel chose what to kill when memory ran out. Each assertion is
 * one a "make it start" edit would plausibly undo — deleting a `mem_limit`
 * because a container was OOM-killed, or raising one past the budget — and
 * none of them fails at `up`. Parsed as YAML, so every assertion is on a value
 * the service has rather than on the file's text.
 *
 * The population is the canonical file plus each overlay that runs on the VM.
 * The pipelock overlay is not in it: it is not enabled, and its limits are owed
 * when it is. The OrangeHRM lab overlay was retired in the same change.
 */
describe('deploy compose — every container has a memory limit and a CPU cap, within the budget', () => {
    const BUDGETED_FILES = [
        CANONICAL,
        'deploy/docker-compose.harness-scanner.yml',
        'deploy/docker-compose.legacy-mcp-proving.yml',
    ] as const;

    /** 16 GB host minus 1.5 GB for the kernel, Docker and the page cache. */
    const MEMORY_BUDGET_MIB = 14848;
    /** The VM's vCPU count: a cap above it is no cap at all. */
    const HOST_CPUS = 2;
    /** Batch-shaped: capped at one core so the request path keeps the other. */
    const BATCH_SERVICES = ['clamav', 'worker', 'harness-scanner'] as const;

    type LimitedService = { mem_limit?: unknown; cpus?: unknown };
    const servicesOf = (rel: string): Record<string, LimitedService> =>
        (yaml.load(read(rel)) as { services: Record<string, LimitedService> }).services;

    /**
     * A Compose byte value in MiB: a bare number of bytes, or a number with a
     * b/k/m/g suffix. Anything else is NaN, so an unparseable limit fails the
     * assertion that reads it rather than counting as zero against the budget.
     */
    function mib(value: unknown): number {
        if (typeof value === 'number') return value / (1024 * 1024);
        if (typeof value !== 'string') return NaN;
        const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(value.trim());
        if (!m) return NaN;
        const factor: Record<string, number> = { b: 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024 };
        return Number(m[1]) * factor[(m[2] ?? 'b').toLowerCase()];
    }

    const all = BUDGETED_FILES.flatMap((rel) =>
        Object.entries(servicesOf(rel)).map(([name, svc]) => ({ rel, name, svc })),
    );

    it('reads every budgeted file and finds its services (the scan is not vacuous)', () => {
        for (const rel of BUDGETED_FILES) {
            expect(Object.keys(servicesOf(rel)).length).toBeGreaterThan(0);
        }
        // Eight canonical services, the scanner and its proxy, the proving server.
        expect(all.length).toBe(11);
    });

    it('the byte parser reads the units Compose accepts', () => {
        expect(mib('1536m')).toBe(1536);
        expect(mib('2g')).toBe(2048);
        expect(mib('512M')).toBe(512);
        expect(mib(1073741824)).toBe(1024);
        expect(mib('lots')).toBeNaN();
        expect(mib(undefined)).toBeNaN();
    });

    it('every service declares a positive, parseable mem_limit', () => {
        const missing = all
            .filter(({ svc }) => !(mib(svc.mem_limit) > 0))
            .map(({ rel, name }) => `${rel}: ${name}`);
        expect(missing).toEqual([]);
    });

    it('every service declares a CPU cap above zero and no larger than the host', () => {
        const bad = all
            .filter(({ svc }) => {
                const cpus = Number(svc.cpus);
                return svc.cpus === undefined || !(cpus > 0 && cpus <= HOST_CPUS);
            })
            .map(({ rel, name }) => `${rel}: ${name}`);
        expect(bad).toEqual([]);
    });

    it(`the memory limits together stay within ${MEMORY_BUDGET_MIB} MiB`, () => {
        const total = all.reduce((sum, { svc }) => sum + mib(svc.mem_limit), 0);
        expect(total).toBeLessThanOrEqual(MEMORY_BUDGET_MIB);
    });

    it.each(BATCH_SERVICES)('%s is batch-shaped and capped at one core', (name) => {
        const found = all.filter((s) => s.name === name);
        expect(found).toHaveLength(1);
        expect(Number(found[0].svc.cpus)).toBeLessThanOrEqual(1);
    });

    /**
     * `mem_limit` moves Node's DEFAULT heap ceiling: with no flag, V8 sizes old
     * space from the cgroup limit (measured: 2096 MiB unlimited, 792 MiB under
     * 1536m). A heap overrun then aborts at about half the limit, exit 134,
     * and no OOM-kill counter sees it. So the app image's two services state
     * the ceiling, below the limit, leaving room for native memory.
     */
    it.each(['app', 'worker'])('%s states a V8 heap ceiling below its mem_limit', (name) => {
        const svc = servicesOf(CANONICAL)[name] as LimitedService & {
            environment?: Record<string, unknown>;
        };
        const nodeOptions = String(svc.environment?.NODE_OPTIONS ?? '');
        const m = /(?:^|\s)--max-old-space-size=(\d+)(?:\s|$)/.exec(nodeOptions);
        expect(m).not.toBeNull();
        const heapMib = Number(m![1]);
        const limitMib = mib(svc.mem_limit);
        // Above the default the cgroup would otherwise impose (about half the
        // limit), and at most three quarters of it: the rest is buffers, code
        // and native allocations, which the old-space flag does not bound.
        expect(heapMib).toBeGreaterThan(limitMib / 2);
        expect(heapMib).toBeLessThanOrEqual(limitMib * 0.75);
    });

    it('the OrangeHRM lab is retired: no overlay, and no service of it in any deploy compose file', () => {
        const composeFiles = repoRelativeFiles().filter((f) => /^deploy\/docker-compose.*\.ya?ml$/.test(f));
        expect(composeFiles).toContain(CANONICAL);
        expect(composeFiles).not.toContain('deploy/docker-compose.orangehrm-lab.yml');
        const labServices = composeFiles.flatMap((f) =>
            Object.keys(servicesOf(f)).filter((n) => n.startsWith('orangehrm')),
        );
        expect(labServices).toEqual([]);
    });
});

describe('deploy scripts — the mechanism that keeps repo and VM in step', () => {
    it.each(['deploy/apply.sh', 'deploy/check-drift.sh'])(
        '%s exists and is executable',
        (rel) => {
            const abs = path.join(REPO_ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
            expect(fs.statSync(abs).mode & 0o111).not.toBe(0);
        },
    );

    it('apply.sh passes BOTH host env files, so interpolation and env_file agree', () => {
        // `env_file:` is not interpolation scope. Dropping `.env.prod` from
        // the --env-file list makes DATA_ENCRYPTION_KEY unresolvable at
        // compose level AND lets the compose-level value diverge from the
        // one the container reads; dropping `.env` makes POSTGRES_PASSWORD
        // unresolvable. This asserts the ENV_FILES array itself, which is
        // the single place apply.sh spells them.
        const declaration = codeLines(read('deploy/apply.sh')).filter((l) =>
            l.startsWith('ENV_FILES='),
        );
        expect(declaration).toEqual(['ENV_FILES=(".env" ".env.prod")']);
    });

    it('both scripts refuse a non-canonical COMPOSE_BASENAME by default', () => {
        // Without this, `COMPOSE_BASENAME=docker-compose.pipelock.yml` is a
        // supported invocation of both — and drift would report green on a
        // file nobody deploys.
        //
        // Anchored at the line START: an unanchored `includes` also matched
        // the refusal message that NAMES the variable, so the assertion was
        // reading its own error text as a second assignment.
        for (const rel of ['deploy/apply.sh', 'deploy/check-drift.sh']) {
            const assignments = codeLines(read(rel)).filter((l) =>
                l.startsWith('CANONICAL_COMPOSE='),
            );
            expect(assignments).toEqual([
                'CANONICAL_COMPOSE="docker-compose.prod.yml"',
            ]);
        }
    });
});

/**
 * The `Scanner VM` workflow reaches the production VM as root, with every
 * credential the harness scanner holds (#3665). Each property below is one an
 * edit "to make it work" would plausibly undo, and none of them would fail a
 * run: the workflow simply becomes something nobody approved. Parsed as YAML,
 * so each assertion is on a value the workflow has, not on its text.
 */
type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string; if?: string };
const wf = yaml.load(read('.github/workflows/scanner-vm.yml')) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { environment?: string; steps: Step[] }>;
};
const job = wf.jobs['scanner-vm'];
const steps = job.steps;

describe('the Scanner VM workflow', () => {
    it('runs only when a person dispatches it', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    });

    it('runs in the production environment, whose reviewer approves each run', () => {
        expect(Object.keys(wf.jobs)).toEqual(['scanner-vm']);
        expect(job.environment).toBe('production');
    });

    it('holds an OIDC token and read access to the code, and nothing else', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    });

    it('authenticates to GCP by Workload Identity Federation, never with a key', () => {
        const auth = steps.filter((s) => s.uses?.startsWith('google-github-actions/auth@'));
        expect(auth).toHaveLength(1);
        expect(Object.keys(auth[0].with ?? {}).sort()).toEqual(['service_account', 'workload_identity_provider']);
    });

    it('reads secrets in one step, which only writes the staged files', () => {
        const withSecrets = steps.filter((s) => JSON.stringify(s).includes('secrets.'));
        expect(withSecrets.map((s) => s.name)).toEqual(['Write the configuration and the credential lines']);
        expect(withSecrets[0].if).toBe("inputs.action == 'configure'");
        expect(withSecrets[0].run).toBe('deploy/harness-scanner/stage-config.sh "$RUNNER_TEMP/harness-scanner"');
    });

    it('always removes the staged credentials from the runner', () => {
        const last = steps[steps.length - 1];
        expect(last.if).toBe('always()');
        expect(last.run).toBe('rm -rf "$RUNNER_TEMP/harness-scanner"');
    });
});

describe('the scripts it runs print no credential', () => {
    const scripts = ['deploy/harness-scanner/remote.sh', 'deploy/harness-scanner/vm.sh', 'deploy/harness-scanner/stage-config.sh'];
    const code = (rel: string) =>
        read(rel)
            .split('\n')
            .filter((l) => !/^\s*#/.test(l));

    it.each(scripts)('%s never traces its commands', (rel) => {
        expect(code(rel).filter((l) => /set\s+-[a-z]*x|set\s+-o\s+xtrace/.test(l))).toEqual([]);
    });

    it.each(scripts)('%s never prints an environment file', (rel) => {
        expect(code(rel).filter((l) => /\b(cat|less|more|head|tail)\b[^|]*\.env(\.prod|\.scanner)?\b/.test(l))).toEqual([]);
    });

    it('configure has the pinned image read the staged configuration, and compares its hosts to EGRESS_ALLOW, before installing anything', () => {
        const lines = code('deploy/harness-scanner/remote.sh');
        const hosts = lines.findIndex((l) => l.includes('hosts --config /etc/scanent/config.json --format egress-allow'));
        const compare = lines.findIndex((l) => l.includes("sed -n 's/^ *EGRESS_ALLOW: *//p'"));
        const firstInstall = lines.findIndex((l) => l.includes('install -m 0644 -o root -g root'));
        expect(hosts).toBeGreaterThan(-1);
        expect(compare).toBeGreaterThan(hosts);
        expect(firstInstall).toBeGreaterThan(compare);
        // The configuration check runs with no network.
        expect(lines.slice(hosts - 2, hosts + 1).join('\n')).toContain('--network none');
    });

    it('the dry run sends the report to the summariser, never to the log', () => {
        const lines = code('deploy/harness-scanner/remote.sh');
        const scan = lines.findIndex((l) => l.includes('scan --dry-run'));
        expect(scan).toBeGreaterThan(-1);
        expect(lines[scan].trimEnd().endsWith('\\')).toBe(true);
        expect(lines[scan + 1].trim().startsWith('| docker run --rm -i --network none --entrypoint node')).toBe(true);
    });
});
