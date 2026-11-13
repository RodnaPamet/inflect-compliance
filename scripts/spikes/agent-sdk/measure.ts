/**
 * What the spike measures, and how: memory of the subprocess tree and of this
 * (host) process, and the installed size of the SDK and its native binary.
 *
 * RSS is sampled every 50 ms. On Linux it is read from /proc (VmRSS of every
 * descendant of this process, summed, plus each one's VmHWM high-water mark);
 * elsewhere (the owner's macOS laptop for `--real`) from `ps`. A sample can
 * miss a spike shorter than the interval, which is why the Linux path also
 * keeps VmHWM, the kernel's own peak per process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type Proc = { pid: number; ppid: number; rssKb: number; hwmKb: number; name: string };

function procTable(): Proc[] {
    if (existsSync('/proc/self/status')) {
        const out: Proc[] = [];
        for (const d of readdirSync('/proc')) {
            if (!/^\d+$/.test(d)) continue;
            try {
                const status = readFileSync(`/proc/${d}/status`, 'utf8');
                const get = (k: string) => Number((status.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0);
                out.push({
                    pid: Number(d),
                    ppid: get('PPid'),
                    rssKb: get('VmRSS'),
                    hwmKb: get('VmHWM'),
                    name: (status.match(/^Name:\s+(.*)$/m) ?? [])[1] ?? '',
                });
            } catch {
                /* the process exited between readdir and read */
            }
        }
        return out;
    }
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .map(([pid, ppid, rss, ...name]) => ({ pid: +pid, ppid: +ppid, rssKb: +rss, hwmKb: +rss, name: name.join(' ') }));
}

function descendants(all: Proc[], root: number): Proc[] {
    const kids = new Map<number, Proc[]>();
    for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
    const out: Proc[] = [];
    const walk = (pid: number) => {
        for (const c of kids.get(pid) ?? []) {
            out.push(c);
            walk(c.pid);
        }
    };
    walk(root);
    return out;
}

export interface RssReport {
    /** Peak of the summed RSS of every descendant process, sampled. */
    childTreePeakMiB: number;
    /** Max VmHWM seen for any one descendant (Linux only; equals sampled RSS elsewhere). */
    childMaxHwmMiB: number;
    /** Peak RSS of this process, sampled, and the kernel's maxRSS for it. */
    hostPeakMiB: number;
    hostMaxRssMiB: number;
    /** Peak of child tree + host, sampled together. */
    combinedPeakMiB: number;
    childNames: string[];
    samples: number;
}

export function startRssSampler(intervalMs = 50) {
    let childTreePeak = 0;
    let childMaxHwm = 0;
    let hostPeak = 0;
    let combinedPeak = 0;
    let samples = 0;
    const names = new Set<string>();
    const sample = () => {
        // `ps` is this sampler's own child off Linux; `esbuild` is tsx's transform server. Neither is the SDK.
        const kids = descendants(procTable(), process.pid).filter((p) => p.name !== 'ps' && p.name !== 'esbuild');
        const tree = kids.reduce((s, p) => s + p.rssKb, 0) / 1024;
        const host = process.memoryUsage().rss / 1024 / 1024;
        for (const k of kids) {
            names.add(k.name);
            childMaxHwm = Math.max(childMaxHwm, k.hwmKb / 1024);
        }
        childTreePeak = Math.max(childTreePeak, tree);
        hostPeak = Math.max(hostPeak, host);
        combinedPeak = Math.max(combinedPeak, tree + host);
        samples++;
    };
    const timer = setInterval(sample, intervalMs);
    sample();
    return {
        stop(): RssReport {
            sample();
            clearInterval(timer);
            const r = (n: number) => Math.round(n * 10) / 10;
            return {
                childTreePeakMiB: r(childTreePeak),
                childMaxHwmMiB: r(childMaxHwm),
                hostPeakMiB: r(hostPeak),
                hostMaxRssMiB: r(process.resourceUsage().maxRSS / 1024),
                combinedPeakMiB: r(combinedPeak),
                childNames: [...names],
                samples,
            };
        },
    };
}

function dirBytes(dir: string): number {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) total += dirBytes(p);
        else if (e.isFile()) total += statSync(p).size;
    }
    return total;
}

const require = createRequire(import.meta.url);

/**
 * A package's directory, found by Node's resolver (which walks up, as an
 * install shared from a parent directory needs). The SDK's `exports` map does
 * not expose its package.json, so resolve the entry point and walk up to the
 * package.json that names the package.
 */
function pkgDir(name: string): string {
    let dir: string;
    try {
        dir = dirname(require.resolve(`${name}/package.json`));
    } catch {
        dir = dirname(require.resolve(name));
    }
    for (;;) {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir;
        const up = dirname(dir);
        if (up === dir) throw new Error(`${name}: no package.json names it`);
        dir = up;
    }
}

export function installedSizes() {
    const sdkDir = pkgDir('@anthropic-ai/claude-agent-sdk');
    const sdkPkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
    const mib = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
    // The native binary is one optional dependency per platform; report each one installed here.
    const platform = Object.keys((sdkPkg.optionalDependencies ?? {}) as Record<string, string>).flatMap((name) => {
        let dir: string;
        try {
            dir = pkgDir(name);
        } catch {
            return [];
        }
        const bin = readdirSync(dir).find((f) => f === 'claude' || f === 'claude.exe');
        return [{ package: name, packageMiB: mib(dirBytes(dir)), binaryMiB: bin ? mib(statSync(join(dir, bin)).size) : null }];
    });
    const peers = ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk'].map((n) => {
        try {
            const d = pkgDir(n);
            return { package: n, version: JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version, MiB: mib(dirBytes(d)) };
        } catch {
            return { package: n, version: null, MiB: null };
        }
    });
    return {
        sdkVersion: sdkPkg.version as string,
        bundledClaudeCodeVersion: (sdkPkg.claudeCodeVersion as string | undefined) ?? null,
        sdkPackageMiB: mib(dirBytes(sdkDir)),
        platform,
        peers,
    };
}
