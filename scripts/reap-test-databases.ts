#!/usr/bin/env tsx
/**
 * Report — and, when told to, delete — orphaned per-worker test databases.
 *
 * ─── What accumulates, and why ──────────────────────────────────────
 *
 * `globalSetup` gives each jest worker its own database,
 * `<base>_<checkoutTag>_w<N>`, and `globalTeardown` drops the ones it
 * created. That works whenever teardown runs. A hard-killed run — a
 * timeout on a long local suite, which is an ordinary thing to do —
 * leaves all of them behind, and the residue is monotonic.
 *
 * Measured on the shared dev Postgres on 2026-10-10: 215 databases,
 * 8676 MB, across 39 checkout tags. The cost is not mainly disk:
 * `CREATE DATABASE … TEMPLATE` against a server holding hundreds of
 * databases is slower than against one holding seven, and that lands
 * on every local run (#3356).
 *
 * `globalSetup` now reaps THIS checkout's own strays automatically,
 * which is safe because the run lock is per (checkout, base database)
 * and held for the whole run. This command exists for everything that
 * rule cannot touch: the tags belonging to checkouts that no longer
 * exist.
 *
 * ─── Why deleting those is not automatic ────────────────────────────
 *
 * Because "this tag has no checkout" is an INFERENCE, and its
 * denominator is however well this process can enumerate checkouts.
 * Measured while writing it: a one-level directory scan found 2 live
 * checkouts among the 39 tags; enumerating properly — `git worktree
 * list` from every clone found, plus a depth-limited scan, 112 roots in
 * total — found 12. The ten it missed were nested agent worktrees under
 * `.claude/worktrees/`. Ten tags would have been labelled dead while
 * their worktrees were in use.
 *
 * Connection count does not rescue the inference either: all 39 tags
 * read `conns = 0` at the time of measurement, including every live
 * one, because a checkout between test runs looks exactly like an
 * abandoned one.
 *
 * So the default is to report. `--unmatched` deletes, and it requires
 * `--yes`, prints the enumeration it is relying on, and never touches a
 * database with a live connection.
 *
 *     npm run db:test:reap                      # report only
 *     npm run db:test:reap -- --mine            # this checkout's strays
 *     npm run db:test:reap -- --unmatched --yes # tags with no checkout found
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { Client } from 'pg';

import {
    adminConnectionString,
    getBaseTestDatabaseUrl,
    getDbName,
    checkoutTag,
    tagForRoot,
} from '../tests/helpers/db';

interface Row {
    datname: string;
    mb: number;
    conns: number;
}

/**
 * Every checkout root this machine can be shown to have.
 *
 * Two independent methods, unioned, because each misses what the other
 * finds: `git worktree list` knows about worktrees whose directory is
 * unusual but only for the clones it is run in, and a filesystem scan
 * finds clones nobody told us about but is bounded by its own depth.
 * The count is printed with the result so the reader can judge the
 * inference rather than inherit it.
 */
function enumerateCheckoutRoots(): { roots: string[]; fromGit: number; fromScan: number } {
    const roots = new Set<string>();
    let fromGit = 0;
    let fromScan = 0;

    const home = process.env.HOME ?? path.resolve('/home', process.env.USER ?? '');
    const scanned: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === 'node_modules' || e.name === '.next') continue;
            const full = path.join(dir, e.name);
            if (fs.existsSync(path.join(full, 'prisma', 'schema'))) {
                scanned.push(full);
            }
            // `.claude/worktrees/**` is where agent checkouts live, so a
            // scan that skips dotted directories misses most of them.
            walk(full, depth + 1);
        }
    };
    walk(home, 1);
    for (const r of scanned) {
        if (!roots.has(r)) fromScan += 1;
        roots.add(r);
    }

    // Each discovered root may be one worktree of a clone that has
    // others; ask git, in every one, and union the answers.
    for (const root of [...scanned, process.cwd()]) {
        try {
            const out = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            for (const line of out.split('\n')) {
                if (!line.startsWith('worktree ')) continue;
                const wt = line.slice('worktree '.length).trim();
                if (wt && !roots.has(wt)) {
                    roots.add(wt);
                    fromGit += 1;
                }
            }
        } catch {
            /* not a git checkout, or git unavailable */
        }
    }
    return { roots: [...roots], fromGit, fromScan };
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const dropMine = argv.includes('--mine');
    const dropUnmatched = argv.includes('--unmatched');
    const confirmed = argv.includes('--yes');

    const baseName = getDbName(getBaseTestDatabaseUrl());
    const myTag = checkoutTag();
    const pattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_([0-9a-f]+)_w(\\d+)$`);

    const admin = new Client({ connectionString: adminConnectionString() });
    await admin.connect();
    // Unfiltered by base on purpose — see `otherBases` below. The whole
    // list is ~100 rows on the busiest server this repo has.
    const { rows: allRows } = await admin.query<Row>(
        `SELECT d.datname,
                (pg_database_size(d.datname) / 1024 / 1024)::int AS mb,
                (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)::int AS conns
           FROM pg_database d
          ORDER BY d.datname`,
    );
    const allShaped = allRows.filter((r) => /_[0-9a-f]+_w\d+$/.test(r.datname));
    const rows = allRows.filter((r) => r.datname.startsWith(baseName));

    const perWorker = rows.filter((r) => pattern.test(r.datname));

    // Every per-worker-SHAPED database on the server, whatever its base
    // name. Reported because this command manages exactly one base and
    // saying "none" while 34 sit there under other bases is the wrong
    // kind of true: a reader takes it as "the server is clean". The
    // bases differ legitimately — a scratch database, a verification
    // run, a shard fixture — and each is some other harness's to reap.
    const otherBases = new Map<string, number>();
    for (const r of allShaped) {
        if (pattern.test(r.datname)) continue;
        const base = r.datname.replace(/_[0-9a-f]+_w\d+$/, '');
        otherBases.set(base, (otherBases.get(base) ?? 0) + 1);
    }
    const reportOtherBases = () => {
        if (otherBases.size === 0) return;
        console.log('');
        console.log('Per-worker databases under OTHER base names — not this command\'s to drop:');
        for (const [base, n] of [...otherBases.entries()].sort()) {
            console.log(`  ${base}  ${n} db`);
        }
    };

    if (perWorker.length === 0) {
        console.log(`No per-worker databases for base "${baseName}" on this server.`);
        reportOtherBases();
        await admin.end();
        return 0;
    }

    const { roots, fromGit, fromScan } = enumerateCheckoutRoots();
    const tagToRoot = new Map<string, string>();
    for (const r of roots) tagToRoot.set(tagForRoot(r), r);

    const byTag = new Map<string, { dbs: Row[]; mb: number; conns: number }>();
    for (const r of perWorker) {
        const tag = pattern.exec(r.datname)![1];
        const g = byTag.get(tag) ?? { dbs: [], mb: 0, conns: 0 };
        g.dbs.push(r);
        g.mb += r.mb;
        g.conns += r.conns;
        byTag.set(tag, g);
    }

    const totalMb = perWorker.reduce((a, r) => a + r.mb, 0);
    console.log(
        `${perWorker.length} per-worker database(s), ${totalMb} MB, ${byTag.size} checkout tag(s).`,
    );
    console.log(`This checkout: ${myTag}  (${process.cwd()})`);
    console.log(
        `Checkout roots enumerated: ${roots.length} (${fromScan} by scan, ${fromGit} more from git worktree list).`,
    );
    console.log('');

    const mine: Row[] = [];
    const unmatched: Row[] = [];
    for (const [tag, g] of [...byTag.entries()].sort((a, b) => b[1].mb - a[1].mb)) {
        const root = tagToRoot.get(tag);
        const label = tag === myTag
            ? 'THIS checkout'
            : root
              ? `live checkout ${root}`
              : 'no checkout root found';
        console.log(
            `  ${tag}  ${String(g.dbs.length).padStart(3)} db  ${String(g.mb).padStart(5)} MB  ` +
                `conns=${g.conns}  ${label}`,
        );
        if (tag === myTag) mine.push(...g.dbs);
        else if (!root) unmatched.push(...g.dbs);
    }
    console.log('');

    const targets: Row[] = [];
    if (dropMine) targets.push(...mine);
    if (dropUnmatched) targets.push(...unmatched);

    if (targets.length === 0) {
        const mineMb = mine.reduce((a, r) => a + r.mb, 0);
        const unmatchedMb = unmatched.reduce((a, r) => a + r.mb, 0);
        console.log('Nothing dropped — this is a report. To delete:');
        console.log(`  --mine        ${mine.length} db, ${mineMb} MB (safe: the run lock covers this tag)`);
        console.log(
            `  --unmatched   ${unmatched.length} db, ${unmatchedMb} MB (needs --yes; the label is an inference —`,
        );
        console.log('                read the enumeration count above before trusting it)');
        reportOtherBases();
        await admin.end();
        return 0;
    }

    if (dropUnmatched && !confirmed) {
        console.error('--unmatched deletes databases on a shared server and needs --yes.');
        console.error(
            `It would drop ${unmatched.length} database(s) across ${
                new Set(unmatched.map((r) => pattern.exec(r.datname)![1])).size
            } tag(s) that this run could not match to a checkout.`,
        );
        await admin.end();
        return 1;
    }

    let dropped = 0;
    let skipped = 0;
    for (const t of targets) {
        if (t.conns > 0) {
            console.log(`  skip ${t.datname} — ${t.conns} live connection(s)`);
            skipped += 1;
            continue;
        }
        try {
            // No `WITH (FORCE)`: the connection counts were read before
            // this loop, and if one has appeared since then failing is
            // the correct outcome, not terminating someone's session.
            await admin.query(`DROP DATABASE IF EXISTS "${t.datname}"`);
            dropped += 1;
        } catch (err) {
            console.log(`  skip ${t.datname} — ${err instanceof Error ? err.message : err}`);
            skipped += 1;
        }
    }
    await admin.end();
    console.log(`Dropped ${dropped} database(s); skipped ${skipped}.`);
    return 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`db:test:reap failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    },
);
