/**
 * Structural ratchet — every file `apply.sh` PUSHES is a file
 * `check-drift.sh` WATCHES, and the host config it pushes is RELOADED.
 *
 * REGRESSION CLASS
 * ----------------
 * #2849 split production config into two halves that must agree: `apply.sh`
 * pushes the repo's copy to the VM, `check-drift.sh` reports when the two
 * diverge. Neither script knows about the other, so the sets they name drift
 * apart silently, and each direction fails differently:
 *
 *   pushed but NOT watched — apply.sh can overwrite a file on the VM that
 *     nothing ever compares again. A hand-edit to it is then invisible until
 *     the next apply blows it away, or until an incident.
 *   watched but NOT pushed — drift reports a divergence no operator can
 *     action with the tool they were pointed at. `deploy/caddy/Caddyfile` has
 *     been exactly that since 2026-09-26, which is why `UNRECONCILED` exists
 *     as a separate array with a REASON per entry: an un-actionable warning
 *     that outlives its explanation is how a check becomes noise.
 *
 * This guard asserts the APPLIABLE direction in both directions. It
 * deliberately says nothing about `UNRECONCILED`, whose whole purpose is to
 * be watched and not pushed.
 *
 * THE SECOND HALF: A COPY IS NOT AN APPLY
 * ---------------------------------------
 * The compose set is activated by `docker compose up -d`, which apply.sh
 * already runs. The HOST config set is activated by a daemon restart, and
 * nothing else in the script does that — so a push with no reload changes
 * exactly nothing while reporting success. `/etc/google-cloud-ops-agent/config.yaml`
 * is the live case: it exports the app's container logs to Cloud Logging, and
 * its failure mode is silence. #3099 existed because that export did not
 * happen at all and a 7-day query returned empty against a working positive
 * control — a config that is present but inert reproduces that exactly.
 *
 * WHY THESE ASSERTIONS EXTRACT BEFORE ASSERTING
 * ---------------------------------------------
 * Both assertion-reach ratchets (#2246) run over this file with a
 * `DRIFT_ALLOWANCE` of 0, so a needle matched against a whole-file read is a
 * counted shape. Every assertion below parses the construct it is about out
 * of the script and asserts on a VALUE.
 *
 * AND THE PARSER ITSELF IS GUARDED
 * --------------------------------
 * A resolver that silently stops substituting `${SCRIPT_DIR}` would leave
 * both sides holding the same literal text, and the set-equality assertions
 * would pass while measuring nothing. `bashArray` throws rather than
 * returning empty, `expand` throws on an unknown variable, and the first test
 * asserts every resolved local path exists on disk.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');

const APPLY = 'deploy/apply.sh';
const DRIFT = 'deploy/check-drift.sh';
const AGENT_CONFIG = 'deploy/ops-agent-config.yaml';

const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** Lines with their leading `#` comments stripped — comments are prose here. */
const codeLines = (src: string): string[] =>
    src.split('\n').filter((l) => !/^\s*#/.test(l));

/**
 * The quoted entries of a top-level `NAME=(` … `)` bash array.
 *
 * Throws on a missing or unterminated array rather than returning `[]`: an
 * empty result would make every set comparison below vacuously true, which is
 * the one failure this guard cannot afford to express as a pass.
 */
function bashArray(src: string, name: string): string[] {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l === `${name}=(`);
    if (start === -1) {
        throw new Error(`${name}=( not found — was the array renamed or reformatted?`);
    }
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\)/.test(lines[i])) return out;
        const m = /^\s*"(.+)"\s*$/.exec(lines[i]);
        if (m) out.push(m[1]);
    }
    throw new Error(`${name}=( was never closed by a line starting with ")"`);
}

/**
 * The shell variables the two arrays interpolate, with the values the scripts
 * give them. Both scripts derive SCRIPT_DIR/REPO_ROOT from BASH_SOURCE, so
 * these are the repo-relative equivalents.
 */
const SHELL_VARS: Record<string, string> = {
    SCRIPT_DIR: 'deploy',
    REPO_ROOT: '.',
    COMPOSE_BASENAME: 'docker-compose.prod.yml',
    LOCAL_COMPOSE: 'deploy/docker-compose.prod.yml',
    REMOTE_DIR: '/opt/inflect',
};

function expand(s: string): string {
    return s.replace(/\$\{([A-Za-z_]+)\}/g, (_m, name: string) => {
        const v = SHELL_VARS[name];
        if (v === undefined) {
            throw new Error(
                `entry interpolates \${${name}}, which this guard cannot resolve — ` +
                    `add it to SHELL_VARS with the value the scripts give it.`,
            );
        }
        return v;
    });
}

type Pair = { local: string; remote: string };

/** `"<local>:<remote>"`, splitting on the FIRST colon. No path here holds one. */
function pair(entry: string, remoteIsBasename: boolean): Pair {
    const expanded = expand(entry);
    const i = expanded.indexOf(':');
    const local = path.normalize(expanded.slice(0, i));
    const rhs = expanded.slice(i + 1);
    return {
        local,
        remote: remoteIsBasename ? `${SHELL_VARS.REMOTE_DIR}/${rhs}` : rhs,
    };
}

/** Everything apply.sh pushes, from both of its arrays. */
function pushedByApply(): Pair[] {
    const src = read(APPLY);
    return [
        ...bashArray(src, 'CANONICAL_SET').map((e) => pair(e, true)),
        ...bashArray(src, 'HOST_CONFIG_SET').map((e) => pair(e, false)),
    ];
}

/** Everything check-drift.sh watches as appliable. */
function watchedByDrift(): Pair[] {
    return bashArray(read(DRIFT), 'APPLIABLE').map((e) => pair(e, false));
}

const asLines = (ps: Pair[]): string[] =>
    ps.map((p) => `${p.local} -> ${p.remote}`).sort();

describe('deploy — the push set and the watch set name the same files', () => {
    it('every resolved local path exists in the repo', () => {
        // The anti-vacuity control. If `expand` stopped substituting, these
        // paths would read `${SCRIPT_DIR}/…` and fail here rather than
        // sailing through the set comparison below as matching literals.
        const all = [...pushedByApply(), ...watchedByDrift()];
        expect(all.length).toBeGreaterThan(0);

        const missing = all
            .map((p) => p.local)
            .filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
        expect(missing).toEqual([]);

        const unresolved = all.filter(
            (p) => p.local.includes('$') || p.remote.includes('$'),
        );
        expect(unresolved).toEqual([]);
    });

    it('apply.sh pushes nothing check-drift.sh fails to watch', () => {
        // A file pushed but unwatched can be hand-edited on the VM and
        // nothing will ever say so.
        const watched = new Set(asLines(watchedByDrift()));
        const unwatched = asLines(pushedByApply()).filter((l) => !watched.has(l));
        expect(unwatched).toEqual([]);
    });

    it('check-drift.sh calls nothing APPLIABLE that apply.sh cannot push', () => {
        // The other direction. A file here that apply.sh does not push gives
        // an operator a red check and a tool that will not fix it — which is
        // what UNRECONCILED is for, and why an entry must not end up here
        // instead.
        const pushed = new Set(asLines(pushedByApply()));
        const unpushable = asLines(watchedByDrift()).filter((l) => !pushed.has(l));
        expect(unpushable).toEqual([]);
    });

    it('HOST_CONFIG_SET carries absolute remote paths outside the compose dir', () => {
        // Its push loop and the drift check both read the right-hand side as
        // an absolute path. A basename there would resolve against the
        // process's cwd on the VM; a path under ${REMOTE_DIR} belongs in
        // CANONICAL_SET, which is pushed with the compose file and activated
        // by `up -d`.
        const hosts = bashArray(read(APPLY), 'HOST_CONFIG_SET').map((e) =>
            pair(e, false),
        );
        expect(hosts.length).toBeGreaterThan(0);
        for (const h of hosts) {
            expect(path.isAbsolute(h.remote)).toBe(true);
            expect(h.remote.startsWith(`${SHELL_VARS.REMOTE_DIR}/`)).toBe(false);
        }
    });
});

describe('deploy — a pushed host config is reloaded, not merely copied', () => {
    const applySrc = () => codeLines(read(APPLY));

    /**
     * Lines that RUN something, with the message emitters dropped.
     *
     * This exists because the first version of the restart assertion below had
     * no teeth, and its own mutation proof is what said so. Deleting the real
     * `ssh_vm "sudo systemctl restart …"` left the guard green, because the two
     * `err "… sudo systemctl restart …"` lines that print the ROLLBACK command
     * also satisfy the needle. The assertion was reading its own advice text as
     * the thing it was asserting about — an ambiguous needle (#2246 Class D) in
     * a guard written to catch inert deploys.
     */
    const executableLines = (): string[] =>
        applySrc().filter((l) => !/^\s*(err|log|warn)\s+"/.test(l));

    /** The single value of a top-level `NAME="…"` assignment. */
    function scalar(name: string): string {
        const hits = applySrc()
            .filter((l) => l.startsWith(`${name}=`))
            .map((l) => l.slice(name.length + 1).replace(/^"|"$/g, ''));
        expect(hits).toHaveLength(1);
        return hits[0];
    }

    it('apply.sh restarts the unit that reads the host config', () => {
        // Without this the push is inert: the agent re-reads its config only
        // at start, so a copied file changes nothing while the script reports
        // a clean apply.
        const unit = scalar('OPS_AGENT_UNIT');
        expect(unit).not.toBe('');

        const mentions = (ls: string[]) =>
            ls.filter(
                (l) =>
                    l.includes('systemctl restart') &&
                    l.includes('${OPS_AGENT_UNIT}'),
            );

        // Exactly one EXECUTION site, and `ssh_vm` is what makes it one: the
        // restart has to happen on the VM, so a line that merely names the
        // command is not one.
        const executed = mentions(executableLines());
        expect(executed).toHaveLength(1);
        expect(executed[0]).toContain('ssh_vm');

        // The visible control for the filter above. The rollback guidance is
        // wanted and does mention the command, so this asserts the prose is
        // both PRESENT and EXCLUDED — if `executableLines` ever stopped
        // filtering, this equality breaks rather than the assertion silently
        // going back to being satisfiable by an error message.
        expect(mentions(applySrc()).length).toBeGreaterThan(executed.length);
    });

    it('apply.sh verifies the restart COMPILED the config it just pushed', () => {
        // `systemctl is-active` goes green for an agent that restarted while
        // keeping its previous pipeline, so the check reads the generated
        // collector config instead. Agent 2.72 compiles logging into
        // otel.yaml rather than fluent-bit, which is why the path matters.
        const compiled = scalar('OPS_AGENT_COMPILED');
        expect(path.isAbsolute(compiled)).toBe(true);

        // Same discipline as the restart above: an executed line, not one of
        // the `err` lines that quote the needle back in the rollback advice.
        const verifies = executableLines().filter(
            (l) =>
                l.includes('${OPS_AGENT_COMPILED_NEEDLE}') &&
                l.includes('${OPS_AGENT_COMPILED}'),
        );
        expect(verifies).toHaveLength(1);
        expect(verifies[0]).toContain('ssh_vm');
    });

    it('the needle apply.sh verifies comes from the config it pushes', () => {
        // Ties the constant to the file. A needle that no longer appears in
        // ops-agent-config.yaml is a verification that cannot fail —
        // it would pass on whatever the collector happened to be running.
        const needle = scalar('OPS_AGENT_COMPILED_NEEDLE');
        expect(needle).not.toBe('');
        const paths = includePaths();
        expect(paths.filter((p) => p.includes(needle))).not.toEqual([]);
    });
});

type AgentConfig = {
    logging?: {
        receivers?: Record<string, { type?: string; include_paths?: string[] }>;
        processors?: Record<string, { type?: string }>;
        service?: {
            pipelines?: Record<
                string,
                { receivers?: string[]; processors?: string[] }
            >;
        };
    };
};

const agentConfig = (): AgentConfig =>
    yaml.load(read(AGENT_CONFIG)) as AgentConfig;

function includePaths(): string[] {
    const receivers = agentConfig().logging?.receivers ?? {};
    return Object.values(receivers).flatMap((r) => r.include_paths ?? []);
}

describe('deploy/ops-agent-config.yaml — the pipeline that exports app logs', () => {
    it('parses as YAML and declares a logging section', () => {
        // The agent's own engine rejects an invalid config and apply.sh runs
        // it in preflight, but that needs the VM. This is the cheap half.
        const doc = agentConfig();
        expect(typeof doc.logging).toBe('object');
    });

    it('a file receiver tails the docker container logs', () => {
        // The app writes Pino JSON to stdout and the json-file driver puts it
        // here. Container log paths are keyed by container ID, which changes
        // on every watchtower recreation, so the glob — not a named path — is
        // what survives a deploy.
        const receivers = agentConfig().logging?.receivers ?? {};
        const fileReceivers = Object.entries(receivers).filter(
            ([, r]) => r.type === 'files',
        );
        expect(fileReceivers.length).toBeGreaterThan(0);
        expect(
            includePaths().filter((p) => p.startsWith('/var/lib/docker/containers/')),
        ).not.toEqual([]);
    });

    it('the app pipeline wires the receiver through every declared processor', () => {
        // A pipeline that names the receiver but drops the exclude processor
        // exports pgbouncer's per-connection noise too: measured on
        // 2026-10-07 at 71 MB/day against the app's ~0.4 MB/day, a 180x
        // ratio. That is a billing and a signal-to-noise regression at once.
        const doc = agentConfig();
        const pipelines = doc.logging?.service?.pipelines ?? {};
        const receiverNames = Object.keys(doc.logging?.receivers ?? {});
        const processorNames = Object.keys(doc.logging?.processors ?? {});
        expect(processorNames.length).toBeGreaterThan(0);

        const appPipelines = Object.values(pipelines).filter((p) =>
            (p.receivers ?? []).some((r) => receiverNames.includes(r)),
        );
        expect(appPipelines.length).toBeGreaterThan(0);
        for (const p of appPipelines) {
            expect([...(p.processors ?? [])].sort()).toEqual(
                [...processorNames].sort(),
            );
        }
    });

    it('default_pipeline is re-declared, so naming a pipeline does not drop syslog', () => {
        // The agent replaces its entire built-in pipeline set as soon as the
        // config names one. Dropping this key does not error — it silently
        // stops host syslog reaching Cloud Logging, which is the kind of
        // absence that reads as "quiet" rather than "broken".
        const pipelines = agentConfig().logging?.service?.pipelines ?? {};
        expect(Object.keys(pipelines)).toContain('default_pipeline');
        expect(pipelines.default_pipeline?.receivers).toEqual(['syslog']);
    });
});
