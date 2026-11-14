/**
 * The capacity recorder records what C1b needs, can never fill the disk, and
 * prints only names and numbers when it is read back.
 *
 * Capacity budget step C1b needs app's and worker's memory peaks across the
 * 02:00–05:30 UTC nightly chain and the 00:15–01:45 UTC parser window. The
 * snapshot cannot give them (Watchtower resets `memory.peak` on every merge,
 * and nobody approves a `VM capacity` run at night), so a timer on the VM
 * records the snapshot's own cgroup files every 10 minutes
 * (`deploy/capacity/recorder/`), installed by `deploy/apply.sh`'s host config
 * set, and `VM capacity`'s history mode reads them (`deploy/capacity/history.sh`).
 *
 * None of this is visible from a green run, and the VM is out of reach, so the
 * scripts are RUN here: the recorder against a fixture cgroup tree and a fake
 * `docker`, the reader against the rows it wrote, and apply.sh's host-config
 * preflight against a fake VM (a directory) through a fake `gcloud`. The
 * units are parsed for the values that tie them to the files apply.sh pushes.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const RECORDER = 'deploy/capacity/recorder/inflect-capacity-record.sh';
const SERVICE = 'deploy/capacity/recorder/inflect-capacity-record.service';
const TIMER = 'deploy/capacity/recorder/inflect-capacity-record.timer';
const HISTORY = 'deploy/capacity/history.sh';
const APPLY = 'deploy/apply.sh';

/** Code lines: comments and blank lines dropped. */
const code = (rel: string) =>
    read(rel)
        .split('\n')
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

/** `Key=value` lines of a unit file. */
function unitValues(rel: string, key: string): string[] {
    return code(rel)
        .filter((l) => l.startsWith(`${key}=`))
        .map((l) => l.slice(key.length + 1));
}

/** apply.sh's HOST_CONFIG_SET entries, `local:remote`, with ${SCRIPT_DIR} resolved. */
function hostConfigSet(): { local: string; remote: string }[] {
    const lines = read(APPLY).split('\n');
    const start = lines.indexOf('HOST_CONFIG_SET=(');
    const end = lines.findIndex((l, i) => i > start && l === ')');
    if (start < 0 || end < 0) throw new Error('HOST_CONFIG_SET=( … ) not found in apply.sh');
    return lines
        .slice(start + 1, end)
        .map((l) => /^\s*"(.+)"\s*$/.exec(l)?.[1])
        .filter((e): e is string => e !== undefined)
        .map((e) => {
            const i = e.indexOf(':');
            return { local: e.slice(0, i).replace('${SCRIPT_DIR}', 'deploy'), remote: e.slice(i + 1) };
        });
}

const DAY = Date.UTC(2026, 10, 13) / 1000; // 2026-11-13T00:00:00Z
const APP = 'a'.repeat(64);
const WORKER = 'b'.repeat(64);
const MiB = 1048576;

type Fixture = {
    root: string;
    bin: string;
    cg: string;
    data: string;
    env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
    setCgroup: (id: string, current: number, peak: number, usageUsec: number) => void;
    record: (at: number) => string;
    history: (hours: string, now: number) => { status: number; out: string };
    cleanup: () => void;
};

/**
 * A fixture host: a cgroup tree, a data directory, and a fake `docker` whose
 * `ps` and `inspect` answer for two containers. `started` sets each one's
 * StartedAt; `dockerDown` makes every docker call fail.
 */
function fixture(opts: { started?: Record<string, string>; dockerDown?: boolean } = {}): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-recorder-'));
    const bin = path.join(root, 'bin');
    const cg = path.join(root, 'cg');
    const data = path.join(root, 'data');
    fs.mkdirSync(bin);
    const started = opts.started ?? { [APP]: '2026-11-12T09:00:00.123456789Z', [WORKER]: '2026-11-12T09:00:01Z' };
    const startedFile = path.join(root, 'started');
    const writeStarted = (s: Record<string, string>) =>
        fs.writeFileSync(startedFile, Object.entries(s).map(([id, t]) => `${id} ${t}`).join('\n') + '\n');
    writeStarted(started);
    fs.writeFileSync(
        path.join(bin, 'docker'),
        [
            '#!/usr/bin/env bash',
            opts.dockerDown ? 'echo "Cannot connect to the Docker daemon" >&2; exit 1' : '',
            'case "$1" in',
            `  ps) printf '%s\\n' "${APP} inflect-app-1" "${WORKER} inflect-worker-1" ;;`,
            `  inspect) shift 2; for id in "$@"; do grep "^$id " "${startedFile}"; done ;;`,
            '  *) echo "unexpected docker call: $*" >&2; exit 9 ;;',
            'esac',
            '',
        ].join('\n'),
        { mode: 0o755 },
    );
    const setCgroup = (id: string, current: number, peak: number, usageUsec: number) => {
        const d = path.join(cg, 'system.slice', `docker-${id}.scope`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'memory.current'), `${current}\n`);
        fs.writeFileSync(path.join(d, 'memory.peak'), `${peak}\n`);
        fs.writeFileSync(path.join(d, 'memory.stat'), `anon ${Math.floor(current * 0.8)}\nfile ${Math.floor(current * 0.2)}\nkernel 4096\n`);
        fs.writeFileSync(path.join(d, 'cpu.stat'), `usage_usec ${usageUsec}\nuser_usec 1\nsystem_usec 1\n`);
    };
    // A minimal environment on purpose: the scripts see nothing inherited.
    // NODE_ENV is there for the repo's ProcessEnv type, which requires it.
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
        NODE_ENV: 'test',
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        DATA_DIR: data,
        CGROUP_ROOT: cg,
        ...extra,
    });
    const record = (at: number) =>
        execFileSync('bash', [path.join(REPO_ROOT, RECORDER)], { env: env({ CAPACITY_NOW: String(at) }), encoding: 'utf8' });
    const history = (hours: string, now: number) => {
        try {
            const out = execFileSync('bash', [path.join(REPO_ROOT, HISTORY), hours], {
                env: env({ CAPACITY_NOW: String(now) }),
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { status: 0, out };
        } catch (e) {
            const x = e as { status: number; stdout: string; stderr: string };
            return { status: x.status, out: `${x.stdout}${x.stderr}` };
        }
    };
    return {
        root,
        bin,
        cg,
        data,
        env,
        setCgroup,
        record,
        history,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
        // exposed for the restart test
        ...{ writeStarted },
    } as Fixture & { writeStarted: typeof writeStarted };
}

/** The data rows of one day file, split on tabs. */
function rowsOf(data: string, day: string): string[][] {
    const f = path.join(data, `capacity-${day}.tsv`);
    return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.split('\t'));
}

/** The rows of the Markdown table whose header starts with `header`. */
function table(out: string, header: string): string[][] {
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`| ${header} |`));
    if (start < 0) return [];
    const rows: string[][] = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
    }
    return rows;
}

/** The value beside `label` in the two-column coverage table. */
function coverage(out: string, label: string): string {
    const row = out.split('\n').find((l) => l.startsWith(`| ${label} |`));
    return row ? row.split('|')[2].trim() : '';
}

describe('the recorder, run against a fixture host', () => {
    it('writes one row per running container: time, name, start, memory and CPU — numbers only', () => {
        const fx = fixture();
        try {
            fx.setCgroup(APP, 500 * MiB, 900 * MiB, 1_000_000);
            fx.setCgroup(WORKER, 300 * MiB, 800 * MiB, 2_000_000);
            fx.record(DAY + 3);
            const rows = rowsOf(fx.data, '2026-11-13');
            expect(rows).toEqual([
                [String(DAY + 3), '2026-11-13T00:00:03Z', 'inflect-app-1', '2026-11-12T09:00:00Z', String(500 * MiB), String(900 * MiB), String(Math.floor(500 * MiB * 0.8)), String(Math.floor(500 * MiB * 0.2)), '1000000'],
                [String(DAY + 3), '2026-11-13T00:00:03Z', 'inflect-worker-1', '2026-11-12T09:00:01Z', String(300 * MiB), String(800 * MiB), String(Math.floor(300 * MiB * 0.8)), String(Math.floor(300 * MiB * 0.2)), '2000000'],
            ]);
            // Root-only: the directory and the file.
            expect(fs.statSync(fx.data).mode & 0o777).toBe(0o700);
            expect(fs.statSync(path.join(fx.data, 'capacity-2026-11-13.tsv')).mode & 0o077).toBe(0);
        } finally {
            fx.cleanup();
        }
    });

    it('writes "-" for a file the kernel does not provide, and skips a container with no cgroup', () => {
        const fx = fixture();
        try {
            fx.setCgroup(APP, 500 * MiB, 900 * MiB, 1);
            fs.rmSync(path.join(fx.cg, 'system.slice', `docker-${APP}.scope`, 'memory.peak'));
            fx.record(DAY + 3);
            const rows = rowsOf(fx.data, '2026-11-13');
            expect(rows.map((r) => [r[2], r[5]])).toEqual([['inflect-app-1', '-']]);
        } finally {
            fx.cleanup();
        }
    });

    it('exits 0 and writes nothing when docker is down', () => {
        const fx = fixture({ dockerDown: true });
        try {
            fx.setCgroup(APP, 1, 1, 1);
            const out = fx.record(DAY + 3);
            expect(out.trim()).toBe('inflect-capacity-record: docker is not answering; nothing recorded');
            expect(fs.readdirSync(fx.data)).toEqual([]);
        } finally {
            fx.cleanup();
        }
    });

    it('keeps today and the eight days before it, by the date in the name', () => {
        const fx = fixture();
        try {
            fx.setCgroup(APP, 1, 1, 1);
            fs.mkdirSync(fx.data, { mode: 0o700 });
            for (const d of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-12']) {
                fs.writeFileSync(path.join(fx.data, `capacity-${d}.tsv`), '# header\n');
            }
            fs.writeFileSync(path.join(fx.data, 'unrelated.txt'), 'x');
            fx.record(DAY + 3);
            expect(fs.readdirSync(fx.data).sort()).toEqual([
                'capacity-2026-11-05.tsv',
                'capacity-2026-11-12.tsv',
                'capacity-2026-11-13.tsv',
                'unrelated.txt',
            ]);
        } finally {
            fx.cleanup();
        }
    });

    it('refuses to write past the day-file cap or the directory cap', () => {
        const fx = fixture();
        try {
            fx.setCgroup(APP, 1, 1, 1);
            fs.mkdirSync(fx.data, { mode: 0o700 });
            const today = path.join(fx.data, 'capacity-2026-11-13.tsv');
            fs.writeFileSync(today, Buffer.alloc(4194304, 0x20));
            expect(fx.record(DAY + 3).trim()).toBe("inflect-capacity-record: today's file is at its cap (4194304 bytes); nothing recorded");
            expect(fs.statSync(today).size).toBe(4194304);

            fs.rmSync(today);
            for (let d = 5; d <= 12; d++) {
                fs.writeFileSync(path.join(fx.data, `capacity-2026-11-${String(d).padStart(2, '0')}.tsv`), Buffer.alloc(5242880, 0x20));
            }
            expect(fx.record(DAY + 3).trim()).toBe('inflect-capacity-record: the data directory is at its cap (41943040 bytes); nothing recorded');
            expect(fs.existsSync(today)).toBe(false);
        } finally {
            fx.cleanup();
        }
    });

    it('asks docker only for ps and inspect, each naming the fields it prints', () => {
        // Every call is bounded by `timeout`; a docker that hangs costs 20 s.
        const calls = code(RECORDER).flatMap((l) => [...l.matchAll(/\btimeout 20 docker ([a-z]+ [^)]*?) 2>\/dev\/null\)/g)].map((m) => m[1]));
        expect(calls).toEqual(["ps --no-trunc --format '{{.ID}} {{.Names}}'", 'inspect --format \'{{.Id}} {{.State.StartedAt}}\' "${IDS[@]}"']);
        // And no other docker verb appears anywhere, in a call or out of one.
        const verbs = code(RECORDER).flatMap((l) => [...l.matchAll(/\bdocker\s+([a-z]+)\s+-/g)].map((m) => m[1]));
        expect(verbs.sort()).toEqual(['inspect', 'ps']);
    });

    it('writes only to its own day file', () => {
        const writes = code(RECORDER).flatMap((l) =>
            (l.match(/\d?>>?\s*\S+/g) ?? []).filter((r) => !/>&\d|>\s*\/dev\/null/.test(r)),
        );
        expect(writes.map((w) => w.replace(/^\d/, '')).sort()).toEqual(['>>"$TODAY_FILE"', '>>"$TODAY_FILE"']);
        expect(code(RECORDER).filter((l) => /\brm\b/.test(l))).toEqual(['    if [[ "$day" < "$CUTOFF" ]]; then rm -f -- "$f"; fi']);
    });
});

describe('the history, read from what the recorder wrote', () => {
    /**
     * A night: a pass every 10 minutes from 00:00 to 06:40, missing 03:20 and
     * 03:30; app's memory climbs through the night, worker restarts at 03:00.
     */
    function night() {
        const fx = fixture() as Fixture & { writeStarted: (s: Record<string, string>) => void };
        for (let i = 0; i <= 40; i++) {
            if (i === 20 || i === 21) continue;
            if (i === 18) fx.writeStarted({ [APP]: '2026-11-12T09:00:00Z', [WORKER]: '2026-11-13T03:00:00Z' });
            const restarted = i >= 18;
            fx.setCgroup(APP, (500 + i * 10) * MiB, (900 + i * 10) * MiB, i * 600_000_000);
            fx.setCgroup(WORKER, 300 * MiB, (restarted ? 350 : 800) * MiB, (restarted ? i - 18 : i) * 300_000_000);
            fx.record(DAY + i * 600 + 3);
        }
        return fx;
    }

    it('reports coverage, and lists every missed pass as a gap rather than a quiet night', () => {
        const fx = night();
        try {
            const r = fx.history('12', DAY + 41 * 600 + 30);
            expect(r.status).toBe(0);
            expect(coverage(r.out, 'Window (UTC)')).toBe('2026-11-12T18:50:30Z to 2026-11-13T06:50:30Z (12 h)');
            expect(coverage(r.out, '10-minute passes recorded / that fit the window')).toBe('39 / 72');
            expect(coverage(r.out, 'First row / last row (UTC)')).toBe('2026-11-13T00:00:03Z / 2026-11-13T06:40:03Z');
            expect(coverage(r.out, 'Day files read / that the window spans')).toBe('1 / 2');
            expect(table(r.out, 'From')).toEqual([
                ['window start', '2026-11-13T00:00:03Z', '310', '30'],
                ['2026-11-13T03:10:03Z', '2026-11-13T03:40:03Z', '30', '2'],
            ]);
        } finally {
            fx.cleanup();
        }
    });

    it('gives each container its peaks, restarts and CPU over the window', () => {
        const fx = night();
        try {
            const rows = table(fx.history('12', DAY + 41 * 600 + 30).out, 'Container');
            expect(rows).toEqual([
                ['inflect-app-1', '39', '900', '1300', '720', '0', '2026-11-12T09:00:00Z', '1.00', '1.00'],
                ['inflect-worker-1', '39', '300', '800', '240', '1', '2026-11-13T03:00:00Z', '0.50', '0.50'],
            ]);
        } finally {
            fx.cleanup();
        }
    });

    it('gives the parser and nightly windows of each day, and says whether memory.peak rose inside them', () => {
        const fx = night();
        try {
            const out = fx.history('12', DAY + 41 * 600 + 30).out;
            expect(table(out, 'Day (UTC) | Window | Passes recorded / that fit')).toEqual([
                ['2026-11-13', 'parser 00:15-01:45', '9 / 9'],
                ['2026-11-13', 'nightly 02:00-05:30', '20 / 22'],
            ]);
            expect(table(out, 'Day (UTC) | Window | Container')).toEqual([
                ['2026-11-13', 'parser 00:15-01:45', 'inflect-app-1', '9', '600', '1000', '480', 'yes'],
                ['2026-11-13', 'parser 00:15-01:45', 'inflect-worker-1', '9', '300', '800', '240', 'no'],
                ['2026-11-13', 'nightly 02:00-05:30', 'inflect-app-1', '20', '830', '1230', '664', 'yes'],
                ['2026-11-13', 'nightly 02:00-05:30', 'inflect-worker-1', '20', '300', '800', '240', 'restarted'],
            ]);
        } finally {
            fx.cleanup();
        }
    });

    it('says plainly when nothing was recorded, and when the recorder is not installed', () => {
        const fx = fixture();
        try {
            const absent = fx.history('24', DAY + 3600);
            expect(absent.status).toBe(0);
            expect(absent.out.split('\n').filter((l) => l.startsWith('No recorder data directory on the VM'))).toHaveLength(1);

            fs.mkdirSync(fx.data, { mode: 0o700 });
            const empty = fx.history('24', DAY + 7 * 3600);
            expect(coverage(empty.out, 'First row / last row (UTC)')).toBe('none: NO ROW IN THE WINDOW. This is a gap, not a quiet night.');
            // The window is 2026-11-12T07:00 to 2026-11-13T07:00: the 12th's
            // windows are before it, the 13th's are both inside it.
            expect(table(empty.out, 'Day (UTC) | Window | Container').map((r) => `${r[0]} ${r[1]} ${r[2]}`)).toEqual([
                '2026-11-13 parser 00:15-01:45 NO ROWS: a gap, not a quiet night',
                '2026-11-13 nightly 02:00-05:30 NO ROWS: a gap, not a quiet night',
            ]);
        } finally {
            fx.cleanup();
        }
    });

    it('skips a malformed row, counts it, and prints nothing from it', () => {
        const fx = fixture();
        try {
            fs.mkdirSync(fx.data, { mode: 0o700 });
            fs.writeFileSync(
                path.join(fx.data, 'capacity-2026-11-13.tsv'),
                [
                    `${DAY + 3}\t2026-11-13T00:00:03Z\tinflect-app-1\t2026-11-12T09:00:00Z\t1048576\t2097152\t1\t1\t5`,
                    `${DAY + 603}\t2026-11-13T00:10:03Z\tPASSWORD=sekret\t-\t1\t1\t1\t1\t1`,
                    `${DAY + 1203}\t2026-11-13T00:20:03Z\tinflect-app-1\t2026-11-12T09:00:00Z\tsekret\t1\t1\t1\t1`,
                    '',
                ].join('\n'),
            );
            const out = fx.history('1', DAY + 1800).out;
            expect(out.split('\n').filter((l) => l.includes('sekret'))).toEqual([]);
            expect(coverage(out, 'Rows unreadable (skipped)')).toBe('2');
            expect(coverage(out, 'Rows read')).toBe('1');
        } finally {
            fx.cleanup();
        }
    });

    it.each(['0', '193', '24h', '-1'])('refuses hours=%j', (hours) => {
        const fx = fixture();
        try {
            expect(fx.history(hours, DAY).status).toBe(2);
        } finally {
            fx.cleanup();
        }
    });

    it('calls no docker and writes nothing', () => {
        expect(code(HISTORY).filter((l) => /\bdocker\s+[a-z]/.test(l))).toEqual([]);
        // A shell redirect to a path or a variable; awk's `>` comparisons
        // (`e > now`) are not redirects and are not counted.
        const writes = code(HISTORY).flatMap((l) =>
            (l.match(/(^|[^>&0-9-])\d?>>?\s*["$\/][^\s;)]*/g) ?? []).filter((r) => !/>\s*\/dev\/null/.test(r)),
        );
        expect(writes).toEqual([]);
        expect(code(HISTORY).filter((l) => /\b(rm|mv|cp|install|tee|touch)\s/.test(l))).toEqual([]);
    });
});

describe('the units, and how apply.sh installs them', () => {
    it('apply.sh pushes the script and both units in its host config set', () => {
        const recorder = hostConfigSet().filter((e) => e.local.startsWith('deploy/capacity/recorder/'));
        expect(recorder).toEqual([
            { local: RECORDER, remote: '/usr/local/lib/inflect-capacity/inflect-capacity-record.sh' },
            { local: SERVICE, remote: '/etc/systemd/system/inflect-capacity-record.service' },
            { local: TIMER, remote: '/etc/systemd/system/inflect-capacity-record.timer' },
        ]);
    });

    it('the service runs the pushed script through bash, as a oneshot, bounded and hardened', () => {
        const script = hostConfigSet().find((e) => e.local === RECORDER)?.remote;
        expect(unitValues(SERVICE, 'ExecStart')).toEqual([`/bin/bash ${script}`]);
        expect(unitValues(SERVICE, 'Type')).toEqual(['oneshot']);
        expect(unitValues(SERVICE, 'StateDirectory')).toEqual(['inflect-capacity']);
        expect(unitValues(SERVICE, 'StateDirectoryMode')).toEqual(['0700']);
        expect(unitValues(SERVICE, 'MemoryMax')).toEqual(['64M']);
        expect(unitValues(SERVICE, 'CPUQuota')).toEqual(['20%']);
        expect(unitValues(SERVICE, 'TimeoutStartSec')).toEqual(['60']);
        expect(unitValues(SERVICE, 'NoNewPrivileges')).toEqual(['yes']);
    });

    it('the timer starts that service every 10 minutes on the clock', () => {
        expect(unitValues(TIMER, 'OnCalendar')).toEqual(['*-*-* *:00/10:00 UTC']);
        expect(unitValues(TIMER, 'Unit')).toEqual(['inflect-capacity-record.service']);
        expect(unitValues(TIMER, 'WantedBy')).toEqual(['timers.target']);
    });

    it('every host config file has an owner, and an unowned path is refused', () => {
        const lines = read(APPLY).split('\n');
        const start = lines.findIndex((l) => l.startsWith('host_config_owner() {'));
        const end = lines.findIndex((l, i) => i > start && l === '}');
        const fn = lines.slice(start, end + 1).join('\n');
        const owner = (p: string) =>
            execFileSync('bash', ['-c', `RECORDER_SCRIPT=/usr/local/lib/inflect-capacity/inflect-capacity-record.sh RECORDER_UNIT=inflect-capacity-record\n${fn}\nhost_config_owner "$1"`, '_', p], {
                encoding: 'utf8',
            }).trim();
        expect(hostConfigSet().map((e) => owner(e.remote))).toEqual(['ops-agent', 'capacity-recorder', 'capacity-recorder', 'capacity-recorder']);
        expect(owner('/etc/systemd/system/something-else.service')).toBe('none');
        // The constants the function reads are the ones apply.sh sets.
        expect(code(APPLY).filter((l) => /^RECORDER_(SCRIPT|UNIT)=/.test(l))).toEqual([
            'RECORDER_UNIT="inflect-capacity-record"',
            'RECORDER_SCRIPT="/usr/local/lib/inflect-capacity/inflect-capacity-record.sh"',
        ]);
    });

    it('apply.sh enables the timer and runs one pass on the VM, then checks for a row', () => {
        const lines = read(APPLY).split('\n');
        const start = lines.findIndex((l) => l.startsWith('recorder_activate() {'));
        const end = lines.findIndex((l, i) => i > start && l === '}');
        const body = lines.slice(start, end + 1).join('\n').replace(/\\\n\s*/g, ' ');
        const runs = body.split('\n').filter((l) => /\bssh_vm\b/.test(l) && !/^\s*(err|log)\s/.test(l));
        expect(runs.filter((l) => l.includes("systemctl enable --now '${RECORDER_UNIT}.timer'") && l.includes("systemctl start '${RECORDER_UNIT}.service'"))).toHaveLength(1);
        expect(runs.filter((l) => l.includes('grep -vc') && l.includes('${RECORDER_DATA_DIR}'))).toHaveLength(1);
    });
});

/**
 * apply.sh's host-config preflight, RUN against a fake VM: a fake `gcloud`
 * that runs the command locally (and copies for scp), a fake `sudo` that
 * answers for the ops agent's engine, and the recorder's fixture host. It
 * writes only under /tmp, which is the point of a preflight.
 */
describe('apply.sh host-config preflight', () => {
    function fakeVm(withCgroups: boolean) {
        const fx = fixture();
        if (withCgroups) {
            fx.setCgroup(APP, 500 * MiB, 900 * MiB, 1);
            fx.setCgroup(WORKER, 300 * MiB, 800 * MiB, 1);
        }
        const vm = path.join(fx.root, 'vm');
        fs.mkdirSync(vm);
        const exe = (name: string, src: string) => fs.writeFileSync(path.join(fx.bin, name), src, { mode: 0o755 });
        exe(
            'gcloud',
            [
                '#!/usr/bin/env bash',
                'if [ "$2" = scp ]; then',
                '  args=(); skip=0',
                '  for a in "$@"; do',
                '    if [ $skip = 1 ]; then skip=0; continue; fi',
                '    case "$a" in --zone) skip=1 ;; --*|compute|scp) ;; *) args+=("$a") ;; esac',
                '  done',
                '  n=${#args[@]}; dest="${args[$((n-1))]}"; exec cp "${args[@]:0:$((n-1))}" "${dest#*:}"',
                'fi',
                'cmd=""; while [ $# -gt 0 ]; do [ "$1" = "--command" ] && { cmd="$2"; shift; }; shift; done',
                'mkdir -p "$HOME/.ssh" && : > "$HOME/.ssh/google_compute_engine"',
                'exec bash -c "$cmd"',
                '',
            ].join('\n'),
        );
        exe(
            'sudo',
            '#!/usr/bin/env bash\ncase "$*" in "test -x /opt/google-cloud-ops-agent/"*) exit 0 ;; esac\ncase "$1" in /opt/google-cloud-ops-agent/*) echo "Valid configuration"; exit 0 ;; esac\nexec "$@"\n',
        );
        const run = () => {
            try {
                const out = execFileSync('bash', [path.join(REPO_ROOT, APPLY)], {
                    env: fx.env({ REMOTE_DIR: vm, HOST_CONFIG_ONLY: '1', APPLY_PUBLIC_LOG: '1', DATA_DIR: '' }),
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                return { status: 0, out };
            } catch (e) {
                const x = e as { status: number; stdout: string; stderr: string };
                return { status: x.status, out: `${x.stdout}${x.stderr}` };
            }
        };
        return { run, cleanup: fx.cleanup };
    }

    const hasSystemdAnalyze = (() => {
        try {
            execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    })();
    const itWithSystemd = hasSystemdAnalyze ? it : it.skip;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

    itWithSystemd('validates the units, runs one trial pass against this host, and changes nothing', () => {
        const vm = fakeVm(true);
        try {
            const r = vm.run();
            expect(r.status).toBe(0);
            const lines = strip(r.out).split('\n').map((l) => l.replace(/^\[apply\]\s*/, '').trim());
            expect(lines.filter((l) => l.startsWith('trial pass OK'))).toEqual(['trial pass OK: 2 row(s) for 2 container(s), memory.peak on 2']);
            expect(lines.filter((l) => l.startsWith('PREFLIGHT ONLY'))).toHaveLength(1);
        } finally {
            vm.cleanup();
        }
    });

    itWithSystemd('refuses when the trial pass finds no container cgroup', () => {
        const vm = fakeVm(false);
        try {
            const r = vm.run();
            expect(r.status).toBe(1);
            const lines = strip(r.out).split('\n').map((l) => l.replace(/^\[apply\] ERROR:\s*/, '').trim());
            expect(lines.filter((l) => l.startsWith("the capacity recorder's trial pass wrote NO row on this host"))).toHaveLength(1);
        } finally {
            vm.cleanup();
        }
    });
});
