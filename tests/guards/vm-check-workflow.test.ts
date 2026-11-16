/**
 * The VM check workflow reaches production read-only, from a fixed list, and
 * prints nothing but names, states and counts.
 *
 * `.github/workflows/vm-check.yml` runs `deploy/vm-check/remote.sh` as root on
 * the production VM, so that Claude's sessions can look at production without
 * holding a key (owner decision, 2026-11-10). It holds the same way in as the
 * `Scanner VM` and `VM capacity` workflows (Workload Identity Federation, the
 * `production` environment's reviewer on every run), and its logs are public,
 * because the repository is. Three things must stay true, and none of them is
 * visible from a green run:
 *
 *   - only a person can start it, behind that reviewer, with no key or secret;
 *   - it runs a check from a fixed list, never a command, because the identity
 *     it holds is root on the VM and a free-text input would make every push a
 *     way to run anything on production;
 *   - the scripts change nothing and print no log line, row or credential.
 *
 * Parsed as YAML and as code lines, so each assertion is on a value, not on a
 * substring of the whole file.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string; if?: string };
type Input = { type?: string; options?: string[] };
const wf = yaml.load(read('.github/workflows/vm-check.yml')) as {
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    permissions: Record<string, string>;
    jobs: Record<string, { environment?: string; 'timeout-minutes'?: number; steps: Step[] }>;
};
const job = wf.jobs['vm-check'];
const steps = job.steps;
const inputs = wf.on.workflow_dispatch.inputs;

/** Code lines: comments and blank lines dropped. */
const code = (rel: string) =>
    read(rel)
        .split('\n')
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

const SCRIPTS = ['deploy/vm-check/remote.sh', 'deploy/vm-check/vm.sh'];

describe('the VM check workflow', () => {
    it('runs only when a person dispatches it', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    });

    it('runs in the production environment, whose reviewer approves each run, with a time limit', () => {
        expect(Object.keys(wf.jobs)).toEqual(['vm-check']);
        expect(job.environment).toBe('production');
        expect(job['timeout-minutes']).toBeGreaterThan(0);
    });

    it('holds an OIDC token and read access to the code, and nothing else', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    });

    it('authenticates to GCP by Workload Identity Federation, never with a key', () => {
        const auth = steps.filter((s) => s.uses?.startsWith('google-github-actions/auth@'));
        expect(auth).toHaveLength(1);
        expect(Object.keys(auth[0].with ?? {}).sort()).toEqual(['service_account', 'workload_identity_provider']);
    });

    it('reads no secret', () => {
        expect(steps.filter((s) => JSON.stringify(s).includes('secrets.')).map((s) => s.name)).toEqual([]);
    });

    it('takes one input, and it is a choice, never free text', () => {
        expect(Object.keys(inputs)).toEqual(['check']);
        expect(inputs.check.type).toBe('choice');
        expect((inputs.check.options ?? []).length).toBeGreaterThan(0);
    });

    it('passes the check through the environment, never into a script line', () => {
        // `${{ inputs.x }}` inside `run:` is pasted into the shell before it
        // runs, so an input becomes code. Through `env:` it stays a value.
        expect(steps.filter((s) => (s.run ?? '').includes('${{')).map((s) => s.name)).toEqual([]);
        expect(steps.filter((s) => s.run).map((s) => s.run)).toEqual(['deploy/vm-check/vm.sh "$CHECK"']);
    });
});

describe('the check list is the same in all three places', () => {
    const choices = [...(inputs.check.options ?? [])].sort();

    it('vm.sh accepts exactly the workflow’s choices', () => {
        const accept = code('deploy/vm-check/vm.sh').find((l) => /^\s*[a-z-]+(\s*\|\s*[a-z-]+)*\)\s*;;\s*$/.test(l));
        expect(accept).toBeDefined();
        const listed = (accept ?? '').replace(/\)\s*;;\s*$/, '').split('|').map((s) => s.trim());
        expect(listed.sort()).toEqual(choices);
    });

    it('remote.sh has exactly one branch per choice, and refuses anything else', () => {
        const branches = code('deploy/vm-check/remote.sh')
            .map((l) => /^([a-z][a-z-]*|\*)\)\s*$/.exec(l)?.[1])
            .filter((b): b is string => b !== undefined);
        expect(branches.filter((b) => b !== '*').sort()).toEqual(choices);
        expect(branches[branches.length - 1]).toBe('*');
    });
});

describe('the scripts it runs', () => {
    const remote = code('deploy/vm-check/remote.sh');

    it.each(SCRIPTS)('%s is executable', (rel) => {
        expect(fs.statSync(path.join(REPO_ROOT, rel)).mode & 0o111).not.toBe(0);
    });

    it.each(SCRIPTS)('%s never traces its commands', (rel) => {
        expect(code(rel).filter((l) => /set\s+-[a-z]*x|set\s+-o\s+xtrace/.test(l))).toEqual([]);
    });

    it.each(SCRIPTS)('%s never prints an environment or compose file', (rel) => {
        expect(
            code(rel).filter((l) => /\b(cat|less|more|head|tail|grep)\b[^|]*(\.env\b|\.ya?ml\b|\/opt\/inflect)/.test(l)),
        ).toEqual([]);
    });

    it('remote.sh calls docker only to list, inspect named fields, read logs and exec', () => {
        const calls = remote.flatMap((l) => l.match(/\bdocker\s+[a-z]+/g) ?? []);
        expect([...new Set(calls.map((c) => c.split(/\s+/)[1]))].sort()).toEqual(['exec', 'inspect', 'logs', 'ps']);
    });

    it('every docker inspect and docker ps names the fields it prints', () => {
        expect(remote.filter((l) => /\bdocker\s+inspect\b/.test(l) && !/docker inspect -f '\{\{\.[A-Za-z.]+\}\}'/.test(l))).toEqual([]);
        const inspected = remote.flatMap((l) => [...l.matchAll(/docker inspect -f '\{\{(\.[A-Za-z.]+)\}\}'/g)].map((m) => m[1]));
        expect([...new Set(inspected)].sort()).toEqual(['.Image', '.State.Health.Status', '.State.StartedAt']);
        expect(remote.filter((l) => /\bdocker\s+ps\b/.test(l) && !/--format '|-qf /.test(l))).toEqual([]);
    });

    it('every docker logs read is piped into a filter, never printed', () => {
        const reads = remote.filter((l) => /\bdocker\s+logs\b/.test(l));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.filter((l) => !/\bdocker logs\b[^|]*2>&1 \| grep -[EF] /.test(l))).toEqual([]);
        expect(reads.filter((l) => !/^\s*[a-z]+="\$\(docker logs /.test(l))).toEqual([]);
    });

    it('docker exec runs only the read-only queries, the bcrypt probe, the tei-embed timing curl and two printenv reads', () => {
        const execs = remote.filter((l) => /\bdocker\s+exec\b/.test(l));
        const psql = execs.filter((l) => l.includes('need postgres'));
        // access-review-dates, automation-rules and migrate-role.
        expect(psql).toHaveLength(3);
        expect(psql.filter((l) => !l.includes("PGOPTIONS='-c default_transaction_read_only=on'"))).toEqual([]);
        expect(execs.filter((l) => l.includes('need app'))).toHaveLength(1);
        // tei-embed-timing: the timed request and the token count.
        const tei = execs.filter((l) => /docker exec -i "\$(1|id)" curl /.test(l));
        expect(tei).toHaveLength(2);
        // migrate-role: one named variable each, into a variable, never stdout.
        const printenv = execs.filter((l) => l.includes(' printenv '));
        expect(printenv.map((l) => l.trim())).toEqual([
            'url="$(docker exec "$app" printenv DIRECT_DATABASE_URL)" && rc=0 || rc=$?',
            'url="$(docker exec "$app" printenv DATABASE_URL)" && rc=0 || rc=$?',
        ]);
        expect(execs).toHaveLength(psql.length + 1 + tei.length + printenv.length);
    });

    describe('tei-embed-timing', () => {
        const fn = (name: string) => {
            const lines = read('deploy/vm-check/remote.sh').split('\n');
            const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
            expect(start).toBeGreaterThan(-1);
            const end = lines.findIndex((l, i) => i > start && l === '}');
            return lines.slice(start, end + 1).join('\n');
        };
        const teiExecs = remote.filter((l) => /docker exec -i "\$(1|id)" curl /.test(l));

        it('every request is a curl to the container’s own loopback port, cut at 60 s, its body from stdin', () => {
            expect(remote).toContain('TEI_URL="http://127.0.0.1:8080"');
            expect(remote).toContain('TEI_TIMEOUT_S=60');
            expect(teiExecs.filter((l) => !l.includes('--max-time "$TEI_TIMEOUT_S"'))).toEqual([]);
            expect(teiExecs.filter((l) => !l.includes('--data-binary @- "$TEI_URL/'))).toEqual([]);
            expect(teiExecs.filter((l) => !/^\s*(tei_body [^|]*\| docker exec|[a-z]+="\$\(tei_body [^|]*\| docker exec)/.test(l))).toEqual([]);
        });

        it('no answer reaches stdout: the timed request discards it, the token count only counts it', () => {
            const timed = teiExecs.filter((l) => l.includes('/v1/embeddings'));
            expect(timed).toHaveLength(1);
            expect(timed[0]).toContain("curl -sS -o /dev/null -w '%{http_code} %{time_total}\\n'");
            const counted = teiExecs.filter((l) => l.includes('/tokenize'));
            expect(counted).toHaveLength(1);
            expect(counted[0]).toMatch(/^\s*tokens="\$\(tei_body tokenize \| docker exec .*\| grep -o '"id":' \| wc -l \|\| true\)"$/);
        });

        it('sends only text generated from a fixed word list, never anything read from the stack', () => {
            const body = fn('tei_body');
            // awk with no input file: everything it prints is built in BEGIN.
            expect(body).toMatch(/awk -v kind="\$1" -v n="\$\{2:-0\}" -v words="\$TEI_PASSAGE_WORDS" -v model="\$TEI_MODEL" '/);
            expect(body).not.toMatch(/\$\(|getline|ENVIRON|docker|psql|\bcat\b|\bhead\b/);
        });

        it('the load is bounded and serial: fixed counts, a time budget, and no background job', () => {
            expect(remote).toContain('TEI_QUERY_CALLS=20');
            expect(remote).toContain('TEI_BATCH_SIZES="8 16 32 64"');
            expect(remote).toContain('TEI_BATCH_REPS=3');
            expect(remote).toContain('TEI_BUDGET_S=480');
            const timing = fn('tei_timing');
            expect(timing.split('\n').filter((l) => /&\s*$|\bxargs\b|\bparallel\b|\bwait\b/.test(l))).toEqual([]);
            expect((timing.match(/-ge "\$TEI_BUDGET_S"/g) ?? []).length).toBe(2);
            // The worst case — every request cut at the timeout just inside the
            // budget — still ends well inside the job's time limit.
            expect((480 + 60 + 2 * 60 + 60) / 60).toBeLessThan(job['timeout-minutes'] ?? 0);
        });

        it('never starts, stops, restarts or recreates a container', () => {
            expect(remote.filter((l) => /\bdocker\s+(run|start|stop|restart|kill|rm|create|compose|update|network|cp)\b/.test(l))).toEqual([]);
        });
    });

    // Every heredoc fed to psql: one per query check, each its own string.
    const sqlHeredocs = (rel: string): string[] =>
        read(rel)
            .split("<<'SQL'")
            .slice(1)
            .map((q) => q.split(/^SQL$/m)[0]);
    const queries = sqlHeredocs('deploy/vm-check/remote.sh');

    it('every query reads and never writes', () => {
        expect(queries).toHaveLength(3);
        expect(queries.filter((q) => !/^\s*SELECT\b/.test(q))).toEqual([]);
        expect(queries.filter((q) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i.test(q))).toEqual([]);
    });

    it('the automation-rules query prints counts, never a rule name, a tenant id or free text', () => {
        // The log is public. A rule's name and its tenant's id are the
        // tenant's; `triggerEvent` is a free String column, so it is printed
        // only when it is an event-name literal and counted as (other) else.
        const automation = queries.filter((q) => q.includes('"AutomationRule"'));
        expect(automation).toHaveLength(1);
        const selected = [...automation[0].matchAll(/SELECT([\s\S]*?)\bFROM\b/g)].map((m) => m[1]);
        expect(selected).toHaveLength(3);
        expect(
            selected.filter((cols) => /"(name|description|id|tenantId|actionConfigJson|triggerFilterJson|createdByUserId)"(?!\))/.test(cols)),
        ).toEqual([]);
        expect(
            automation.filter((q) => q.includes(`CASE WHEN "triggerEvent" ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN "triggerEvent" ELSE '(other)' END`)),
        ).toHaveLength(1);
        expect(automation.filter((q) => q.includes('count(DISTINCT "tenantId")'))).toHaveLength(1);
    });

    it('remote.sh writes no file on the VM', () => {
        // Redirects to stderr and /dev/null only; the report goes to stdout.
        const writes = remote.flatMap((l) =>
            (l.match(/\d?>>?\s*\S+/g) ?? []).filter((r) => !/>&[12];?\)?"?$|>\s*\/dev\/null;?$/.test(r)),
        );
        expect(writes).toEqual([]);
    });

    it('vm.sh touches nothing on the VM but its own stage directory', () => {
        const calls = code('deploy/vm-check/vm.sh').filter((l) => /^\s*ssh_vm\s/.test(l));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter((l) => !l.includes('vm-check-stage'))).toEqual([]);
    });
});

/**
 * tei-embed-timing RUN, against a fake `docker` and a fake cgroup directory.
 * The fake answers each timed request with curl's `-w` line, as the image's
 * curl would, and puts a sentinel in every body it would return, so a body that
 * reached stdout would show. It also records every request body, which must be
 * the script's own synthetic text.
 */
describe('tei-embed-timing, run against a fake docker', () => {
    const SENTINEL = 'SENTINEL_FROM_THE_SERVICE';
    const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_ROOT/calls"
case "$1" in
ps) echo "$FAKE_ID" ;;
inspect) case "$3" in *Health*) echo "\${FAKE_HEALTH:-healthy}" ;; *) echo 2026-11-15T10:00:00.123456Z ;; esac ;;
exec)
    body="$(cat)"; printf '%s\\n' "$body" >> "$FAKE_ROOT/bodies"
    url="\${*: -1}"
    if [[ "$url" == */tokenize ]]; then
        printf '[['; for i in $(seq 1 600); do printf '{"id":%d,"text":"${SENTINEL}"},' "$i"; done; printf ']]'; exit 0
    fi
    [[ " $* " == *" -o /dev/null "* ]] || printf '{"data":[{"embedding":[0.1]}],"note":"${SENTINEL}"}'
    n="$(grep -o 'synthetic passage' <<< "$body" | wc -l)"
    if [ "$n" = 64 ]; then
        echo 1900000000 > "$FAKE_CG/memory.peak"
        printf 'usage_usec 90000000\\nnr_periods 900\\nnr_throttled 300\\nthrottled_usec 4000000\\n' > "$FAKE_CG/cpu.stat"
    fi
    if [ "$n" = "\${FAKE_TIMEOUT_AT:-none}" ]; then printf '000 60.001\\n'; exit 28; fi
    awk -v n="$n" 'BEGIN { printf "200 %.6f\\n", (n == 0 ? 0.0123 : n * 0.3) }'
    ;;
*) echo "fake docker: $1" >&2; exit 2 ;;
esac
`;

    function run(env: Record<string, string> = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-check-tei-'));
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
        const id = 'f'.repeat(64);
        const cg = path.join(root, 'cgroup', 'system.slice', `docker-${id}.scope`);
        fs.mkdirSync(cg, { recursive: true });
        const files: Record<string, string> = {
            'memory.current': '1700000000',
            'memory.peak': '1800000000',
            'memory.max': '2684354560',
            'cpu.max': '100000 100000',
            'memory.stat': 'anon 1200000000\nfile 487000000\n',
            'memory.events': 'oom_kill 0\n',
            'cpu.stat': 'usage_usec 10000000\nnr_periods 100\nnr_throttled 3\nthrottled_usec 100000\n',
        };
        for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(cg, f), `${v}\n`);
        const p = spawnSync('bash', [path.join(REPO_ROOT, 'deploy/vm-check/remote.sh'), 'tei-embed-timing'], {
            // NODE_ENV: the repo's ProcessEnv type requires it.
            env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, FAKE_ROOT: root, FAKE_ID: id, FAKE_CG: cg, CGROUP_ROOT: path.join(root, 'cgroup'), ...env },
            encoding: 'utf8',
        });
        const readOr = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
        const result = { status: p.status, stdout: p.stdout, stderr: p.stderr, calls: readOr('calls'), bodies: readOr('bodies') };
        fs.rmSync(root, { recursive: true, force: true });
        return result;
    }

    const ok = run();

    it('runs, and prints a verdict for every batch size against the 15 s deadline', () => {
        expect(ok.status).toBe(0);
        const verdicts = ok.stdout.split('\n').filter((l) => /^- \d+ passages: /.test(l));
        expect(verdicts).toEqual([
            '- 8 passages: within 15 s (slowest 2.40 s of 3 runs)',
            '- 16 passages: within 15 s (slowest 4.80 s of 3 runs)',
            '- 32 passages: within 15 s (slowest 9.60 s of 3 runs)',
            '- 64 passages: over 15 s (slowest 19.20 s of 3 runs)',
        ]);
    });

    it('prints the query’s percentiles and each batch size’s min, median and max', () => {
        const rows = ok.stdout.split('\n');
        expect(rows).toContain('| 20 | 12.3 | 12.3 | 12.3 | 12.3 |');
        expect(rows).toContain('| 64 | 3 | 19.20 | 19.20 | 19.20 | 19.20 |');
        expect(rows).toContain('| Tokens in one synthetic passage | 600 (the model reads 512; --auto-truncate cuts the rest) |');
    });

    it('reads the cgroup before and after: memory.peak and CPU throttling', () => {
        const rows = ok.stdout.split('\n');
        expect(rows).toContain('| memory.peak (MiB) | 1717 | 1812 |');
        expect(rows).toContain('| Throttled periods | 297 of 800 |');
        expect(rows).toContain('| tei-embed memory limit (MiB) | 2560 |');
    });

    it('never prints a response body: only names and numbers reach stdout', () => {
        expect(ok.stdout).not.toContain(SENTINEL);
        expect(ok.stdout).not.toContain('embedding');
        // Every table row's cells are numbers, "-", "n/a" or a fixed label.
        const cells = ok.stdout
            .split('\n')
            .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
            .flatMap((l) => l.split('|').slice(2, -1).map((c) => c.trim()));
        const freeText = cells.filter(
            (c) => !/^(-|n\/a|yes \/ no|yes \/ yes|no \/ no|no \/ yes|[0-9.]+( [0-9.]+)?|[0-9]+ of [0-9]+|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d|Before|After|Value|Min ms|p50 ms|p95 ms|Max ms|Runs|Min s|Median s|p95 s|Max s|600 \(the model reads 512; --auto-truncate cuts the rest\))$/.test(c),
        );
        // The host CPU's model name is the one cell read from outside the script.
        expect(freeText.length).toBeLessThanOrEqual(1);
    });

    it('sends only the script’s synthetic text, serially, to the container’s loopback port', () => {
        const bodies = ok.bodies.trim().split('\n').map((b) => JSON.parse(b) as { model?: string; input?: string[]; inputs?: string });
        // tokenize, two warm-ups, 20 queries, 3 runs of each of 4 sizes.
        expect(bodies).toHaveLength(1 + 2 + 20 + 12);
        const texts = bodies.flatMap((b) => b.input ?? [b.inputs ?? '']);
        expect(texts.filter((t) => !/^(query|passage): /.test(t))).toEqual([]);
        expect(texts.filter((t) => !/^[a-z0-9 .:]+$/.test(t))).toEqual([]);
        expect(bodies.filter((b) => b.input).map((b) => b.model)).toEqual(Array(34).fill('intfloat/multilingual-e5-small'));
        const sizes = bodies.filter((b) => b.input && b.input[0].startsWith('passage: ')).map((b) => b.input?.length);
        expect(sizes).toEqual([8, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64]);
        const execs = ok.calls.split('\n').filter((l) => l.startsWith('exec '));
        expect(execs.filter((l) => !/ curl .*--max-time 60 .*--data-binary @- http:\/\/127\.0\.0\.1:8080\/(v1\/embeddings|tokenize)$/.test(l))).toEqual([]);
        expect(ok.calls.split('\n').filter((l) => l && !/^(ps|inspect|exec) /.test(l))).toEqual([]);
    });

    it('a batch that times out is over the deadline, and the larger sizes are not sent', () => {
        const r = run({ FAKE_TIMEOUT_AT: '32' });
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n').filter((l) => /^- (32|64) passages: /.test(l))).toEqual([
            '- 32 passages: over 15 s (no answer within 60 s)',
            '- 64 passages: not measured (a smaller batch failed)',
        ]);
        expect(r.bodies.split('\n').filter((b) => (b.match(/synthetic passage/g) ?? []).length === 64)).toEqual([]);
    });

    it('sends nothing to a container that is not healthy', () => {
        const r = run({ FAKE_HEALTH: 'starting' });
        expect(r.status).toBe(1);
        expect(r.bodies).toBe('');
        expect(r.stderr).toContain('not healthy: no load sent');
    });
});

/**
 * migrate-role: which database role `prisma migrate deploy` runs as, and
 * whether it is a superuser (#5720's `CREATE EXTENSION vector` needs one). The
 * app container's URL carries a REAL password and the run's log is public, so
 * the URL must never leave its shell variable: only the role, the database name
 * (each only when it is a plain identifier) and the host's class are printed.
 */
describe('migrate-role', () => {
    const fnBody = (() => {
        const lines = read('deploy/vm-check/remote.sh').split('\n');
        const start = lines.findIndex((l) => l.startsWith('migrate_role() {'));
        const end = lines.findIndex((l, i) => i > start && l === '}');
        return lines.slice(start, end + 1);
    })();
    const fnCode = fnBody.filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
    const sql = (() => {
        const all = fnBody.join('\n');
        return all.split("<<'SQL'")[1].split(/^SQL$/m)[0];
    })();

    it('resolves the URL as prisma.config.ts does: DIRECT_DATABASE_URL when set, DATABASE_URL otherwise', () => {
        expect(codeOf(read('prisma.config.ts'))).toContain("url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? ''");
    });

    it('the URL is read into a variable and touched once more, by a parameter expansion, never passed anywhere', () => {
        const uses = fnCode.filter((l) => /\$\{?url\b/.test(l));
        expect(uses.map((l) => l.trim())).toEqual(['rest="${url#*://}"']);
        // No pipe, echo, printf or here-string carries it or the pieces holding the password.
        expect(fnCode.filter((l) => /\$\{?(rest|userinfo|hostpart)\b/.test(l) && /\||<<<|\becho\b|\bprintf\b/.test(l))).toEqual([]);
    });

    it('asks psql with the role as a -v variable read as :\'r\', never interpolated into the SQL', () => {
        const call = fnCode.filter((l) => /\bpsql\b/.test(l));
        expect(call).toHaveLength(1);
        expect(call[0]).toContain('-v r="$role"');
        expect(call[0]).toContain('-U postgres');
        expect(call[0]).toContain("PGOPTIONS='-c default_transaction_read_only=on'");
        expect(call[0]).toMatch(/<<'SQL'$/);
        expect(call[0]).not.toMatch(/\s-c\s/);
        expect(sql).toContain("WHERE rolname = :'r'");
        expect(sql).not.toMatch(/\$/);
    });

    it('runs SELECTs only', () => {
        const statements = sql.split(';').map((q) => q.trim()).filter(Boolean);
        expect(statements).toHaveLength(3);
        expect(statements.filter((q) => !/^SELECT\b/.test(q))).toEqual([]);
        expect(statements.filter((q) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i.test(q))).toEqual([]);
    });

    const PW_DIRECT = 'Pw-DIRECTsecret-9f8e7d6c5b4a3f2e1d0c';
    const PW_POOLED = 'Pw-POOLEDsecret-0a1b2c3d4e5f6a7b8c9d';
    const DIRECT = `postgresql://inflect_app:${PW_DIRECT}@postgres:5432/inflect_compliance?schema=public`;
    const POOLED = `postgresql://inflect_app:${PW_POOLED}@pgbouncer:6432/inflect_compliance?pgbouncer=true`;

    const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_ROOT/calls"
case "$1" in
ps) svc="\${3##*=}"; echo "id-$svc" ;;
exec)
    if [ "$2" = id-app ] && [ "$3" = printenv ]; then
        v="FAKE_$4"; [ -n "\${!v+set}" ] || exit 1; printf '%s\\n' "\${!v}"; exit 0
    fi
    if [ "$4" = id-postgres ] || [[ " $* " == *" psql "* ]]; then
        cat >> "$FAKE_ROOT/sql"
        [ -z "\${FAKE_PSQL_FAIL:-}" ] || exit 2
        case " $* " in
        *" r=postgres "*) echo "role yes yes" ;;
        *" r=missing "*) ;;
        *) echo "role no no" ;;
        esac
        echo "available 1 0.8.1"
        echo "installed \${FAKE_INSTALLED:-0} \${FAKE_INSTALLED_V:--}"
        exit 0
    fi
    echo "fake docker: unexpected exec $*" >&2; exit 2 ;;
*) echo "fake docker: $1" >&2; exit 2 ;;
esac
`;

    function run(env: Record<string, string>) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-check-role-'));
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
        const p = spawnSync('bash', [path.join(REPO_ROOT, 'deploy/vm-check/remote.sh'), 'migrate-role'], {
            env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, FAKE_ROOT: root, ...env },
            encoding: 'utf8',
        });
        const readOr = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
        const result = { status: p.status, stdout: p.stdout, stderr: p.stderr, calls: readOr('calls'), sql: readOr('sql') };
        fs.rmSync(root, { recursive: true, force: true });
        return result;
    }
    const verdict = (out: string) => out.split('\n').filter((l) => l.startsWith('migrations run as '));

    const both = run({ FAKE_DIRECT_DATABASE_URL: DIRECT, FAKE_DATABASE_URL: POOLED });

    it('never prints a password, and never passes one to any command', () => {
        expect(both.status).toBe(0);
        for (const pw of [PW_DIRECT, PW_POOLED, 'secret']) {
            expect(both.stdout).not.toContain(pw);
            expect(both.stderr).not.toContain(pw);
            expect(both.calls).not.toContain(pw);
            expect(both.sql).not.toContain(pw);
        }
        expect(both.stdout).not.toContain('postgresql://');
    });

    it('reads DIRECT_DATABASE_URL first, and names the role, the host class and the database', () => {
        const rows = both.stdout.split('\n');
        expect(rows).toContain('| Supplied by | DIRECT_DATABASE_URL |');
        expect(rows).toContain('| Role | inflect_app |');
        expect(rows).toContain('| Host | the postgres service |');
        expect(rows).toContain('| Database | inflect_compliance |');
        expect(both.calls.split('\n').filter((l) => l.includes('printenv'))).toEqual(['exec id-app printenv DIRECT_DATABASE_URL']);
    });

    it('asks Postgres as postgres, in the app database, with the role as a psql variable', () => {
        const psql = both.calls.split('\n').filter((l) => l.includes(' psql '));
        expect(psql).toEqual([
            "exec -i -e PGOPTIONS=-c default_transaction_read_only=on id-postgres psql -X -q -tA -F   -v ON_ERROR_STOP=1 -U postgres -d inflect_compliance -v r=inflect_app",
        ]);
        expect(both.sql).toContain(":'r'");
        expect(both.sql).not.toContain('inflect_app');
        expect(both.sql.split(';').map((q) => q.trim()).filter(Boolean).filter((q) => !/^SELECT\b/.test(q))).toEqual([]);
    });

    it('prints the verdict, and says the extension must be created first as postgres when the role is not a superuser', () => {
        expect(verdict(both.stdout)).toEqual(['migrations run as inflect_app, superuser: no; vector available: yes; installed: no']);
        expect(both.stdout).toContain('create the extension first, once, as `postgres`');
        expect(both.stdout.split('\n')).toContain('| vector available (default version) | yes (0.8.1) |');
    });

    it('a superuser role needs no note', () => {
        const r = run({ FAKE_DIRECT_DATABASE_URL: `postgresql://postgres:${PW_DIRECT}@postgres:5432/inflect_compliance` });
        expect(verdict(r.stdout)).toEqual(['migrations run as postgres, superuser: yes; vector available: yes; installed: no']);
        expect(r.stdout).not.toContain('create the extension first');
        expect(r.stdout).not.toContain(PW_DIRECT);
    });

    it('a non-superuser with the extension already installed is told it has nothing to do', () => {
        const r = run({ FAKE_DIRECT_DATABASE_URL: DIRECT, FAKE_INSTALLED: '1', FAKE_INSTALLED_V: '0.8.1' });
        expect(verdict(r.stdout)).toEqual(['migrations run as inflect_app, superuser: no; vector available: yes; installed: yes']);
        expect(r.stdout).not.toContain('create the extension first');
    });

    it('falls back to DATABASE_URL only when DIRECT_DATABASE_URL is unset, and classes pgbouncer', () => {
        const r = run({ FAKE_DATABASE_URL: POOLED });
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n')).toContain('| Supplied by | DATABASE_URL (the fallback: DIRECT_DATABASE_URL is unset) |');
        expect(r.stdout.split('\n')).toContain('| Host | pgbouncer |');
        expect(r.stdout).not.toContain(PW_POOLED);
        expect(r.calls).not.toContain(PW_POOLED);
    });

    it('a SET but empty DIRECT_DATABASE_URL is the one used, as `??` uses it', () => {
        const r = run({ FAKE_DIRECT_DATABASE_URL: '', FAKE_DATABASE_URL: POOLED });
        expect(r.stdout.split('\n')).toContain('| Supplied by | DIRECT_DATABASE_URL |');
        expect(r.calls.split('\n').filter((l) => l.includes('printenv'))).toEqual(['exec id-app printenv DIRECT_DATABASE_URL']);
        expect(r.calls).not.toContain(' psql ');
    });

    it('an unsafe user name is printed as unprintable, and nothing is asked of Postgres', () => {
        const r = run({ FAKE_DIRECT_DATABASE_URL: `postgresql://Robert');DROP-${PW_DIRECT}:${PW_DIRECT}@postgres:5432/inflect_compliance` });
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n')).toContain('| Role | unprintable |');
        expect(r.stdout).not.toContain('Robert');
        expect(r.stdout).not.toContain(PW_DIRECT);
        expect(r.calls).not.toContain(' psql ');
        expect(r.sql).toBe('');
        expect(verdict(r.stdout)).toEqual(['migrations run as unprintable, superuser: not asked; vector available: not asked; installed: not asked']);
    });

    it('a URL with no user at all is unprintable too, and a role Postgres does not hold is said so', () => {
        expect(run({ FAKE_DIRECT_DATABASE_URL: 'postgresql://postgres:5432/inflect_compliance' }).stdout.split('\n')).toContain('| Role | unprintable |');
        const r = run({ FAKE_DIRECT_DATABASE_URL: `postgresql://missing:${PW_DIRECT}@postgres/inflect_compliance` });
        expect(verdict(r.stdout)).toEqual(['migrations run as missing, superuser: no such role; vector available: yes; installed: no']);
    });

    it('a Postgres that does not answer reads unknown, never no', () => {
        const r = run({ FAKE_DIRECT_DATABASE_URL: DIRECT, FAKE_PSQL_FAIL: '1' });
        expect(r.status).toBe(0);
        expect(verdict(r.stdout)).toEqual(['migrations run as inflect_app, superuser: unknown; vector available: unknown; installed: unknown']);
        expect(r.stdout).not.toContain('create the extension first');
    });

    it('neither variable set says so and asks nothing', () => {
        const r = run({});
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n')).toContain('| Supplied by | neither (DIRECT_DATABASE_URL and DATABASE_URL are both unset) |');
        expect(r.calls).not.toContain(' psql ');
    });
});
