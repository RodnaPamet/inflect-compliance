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
    };
    const doc = yaml.load(read(SCANNER_OVERLAY)) as { services: Record<string, Service> };
    const svc = doc.services['harness-scanner'];

    it('defines the scanner and nothing else', () => {
        expect(Object.keys(doc.services)).toEqual(['harness-scanner']);
    });

    it('pins the published image by digest', () => {
        expect(svc.image).toMatch(/^ghcr\.io\/rodnapamet\/agent-harness-scanner@sha256:[0-9a-f]{64}$/);
    });

    it('reads its own environment file, never .env.prod, and interpolates nothing', () => {
        expect(svc.env_file).toEqual(['./.env.scanner']);
        expect(svc.environment).toBeUndefined();
    });

    it('runs read-only, unprivileged, as uid 1000, with every capability dropped', () => {
        expect(svc.read_only).toBe(true);
        expect(svc.user).toBe('1000:1000');
        expect(svc.cap_drop).toEqual(['ALL']);
        expect(svc.security_opt).toEqual(['no-new-privileges:true']);
    });

    it('mounts only its configuration directory, read-only', () => {
        expect(svc.volumes).toEqual(['./harness-scanner:/etc/agent-harness-scanner:ro']);
    });

    it('serves nothing and is never auto-updated', () => {
        expect(svc.ports).toBeUndefined();
        expect(svc.expose).toBeUndefined();
        expect(svc.labels).toBeUndefined();
    });

    it('runs the schedule against the mounted configuration', () => {
        expect(svc.command).toEqual(['schedule', '--config', '/etc/agent-harness-scanner/config.json']);
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

    it('the dry run sends the report to the summariser, never to the log', () => {
        const lines = code('deploy/harness-scanner/remote.sh');
        const scan = lines.findIndex((l) => l.includes('scan --dry-run'));
        expect(scan).toBeGreaterThan(-1);
        expect(lines[scan].trimEnd().endsWith('\\')).toBe(true);
        expect(lines[scan + 1].trim().startsWith('| docker run --rm -i --network none --entrypoint node')).toBe(true);
    });
});
