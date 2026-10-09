#!/usr/bin/env node
/**
 * Does the GENERATED Prisma client still match `prisma/schema/`? (#3310)
 *
 * ─── The hazard ─────────────────────────────────────────────────────
 *
 * `node_modules/` is shared across every worktree in this checkout and
 * `node_modules/.prisma/client` is not branch-tracked, so the generated
 * client belongs to whichever branch ran `prisma generate` last — which
 * may be a *different worktree's* branch, changed under you while you
 * were not looking.
 *
 * When it is behind, `tsc` reports the difference as ordinary type
 * errors in files you have never touched. Measured on this repo: a
 * client generated on a branch without `ExternalWriteOutcome.ACCEPTED`
 * produced 13 errors across 6 files in a subsystem the author was not
 * working in. Every one of them read as a product defect in somebody
 * else's code, and the natural conclusion — "main is broken" — is
 * wrong.
 *
 * It is silent in the other direction too. A client AHEAD of the branch
 * type-checks your code against columns this branch does not have, and
 * that PASSES. The error surfaces later, in CI, as something else.
 *
 * ─── Why the answer has to come BEFORE the type errors ──────────────
 *
 * Afterwards it cannot be had. Thirteen plausible type errors cue
 * "read the errors", not "check the generator", and once you are
 * reading them a stale-client error is indistinguishable from a real
 * one — they are the same sentence about the same symbol. The only
 * place this question is cheap to answer is before `tsc` prints
 * anything, which is why this runs as `pretypecheck` rather than as
 * advice in a document.
 *
 * ─── Why it does NOT regenerate for you ─────────────────────────────
 *
 * Because that is unsafe and this process cannot tell whether it is
 * safe. `prisma generate` rewrites `.prisma/client/index.js` in place,
 * and a jest worker that reads it mid-write throws `ENOENT` — with
 * ~765 suites across the worktrees sharing this `node_modules`, a
 * regenerate at the wrong moment takes down a peer's whole run. So
 * this check reports, names the command, and lists the jest and tsc
 * processes currently reading the client — with whose worktree each one
 * is in — so the decision can be made with the one fact a type error
 * never carries.
 *
 * ─── Why this is NOT a CI gate ──────────────────────────────────────
 *
 * The same reason `check-applied-migration-drift.mjs` is not one: CI
 * generates the client fresh from the committed schema on every job
 * (`.github/actions/setup-node-prisma`), so there the two cannot
 * disagree. Its true-positive rate in CI is structurally zero, and a
 * check that can only ever fire on the innocent is the thing this
 * repo has a written rule against. It therefore exits immediately and
 * silently when `CI` is set: zero CI time, zero CI blast radius, and
 * it blocks only on the one-developer-one-worktree failure it can
 * actually see.
 *
 * COVERAGE, stated rather than implied: this compares Prisma-LEVEL
 * names only — model names, field names, enum names, enum values. It
 * is blind to everything `@map`/`@@map` renames at the database level,
 * to attribute and type changes on a field that keeps its name. It also
 * covers `npm run typecheck` ONLY: `typecheck:ui-boundary` and
 * `typecheck:rendered` have no such hook, so a stale client still
 * reaches those as bare type errors.
 *
 * Escape hatch: `SKIP_PRISMA_FRESHNESS=1 npm run typecheck`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

/**
 * Parse model/enum declarations out of the schema folder.
 *
 * Deliberately NOT a Prisma parse — loading the schema engine costs
 * more than the thing this is trying to save. It reads Prisma-level
 * names, which is all the comparison needs, and its correctness is
 * checked by equality against a freshly generated client: a parser that
 * over- or under-reads shows up as a diff on a clean tree.
 */
function parseSchema() {
    const models = new Map();
    const enums = new Map();
    let current = null;

    for (const file of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
        const text = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (line === '' || line.startsWith('//')) continue;

            if (current === null) {
                const open = /^(model|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(line);
                if (open) current = { kind: open[1], name: open[2], members: new Set() };
                continue;
            }

            if (line.startsWith('}')) {
                (current.kind === 'model' ? models : enums).set(current.name, current.members);
                current = null;
                continue;
            }
            if (line.startsWith('@@')) continue;

            if (current.kind === 'enum') {
                const v = /^([A-Za-z_]\w*)/.exec(line);
                if (v) current.members.add(v[1]);
            } else {
                // `name Type` — the second token guard rejects a wrapped
                // attribute continuation such as `references: [id])`,
                // whose first token would otherwise read as a field.
                const f = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?\??/.exec(line);
                if (f) current.members.add(f[1]);
            }
        }
    }
    return { models, enums };
}

/**
 * Which generated client would a process running in `dir` import?
 *
 * Needed because a bare "is jest running" count is wrong in both
 * directions here. This machine runs sessions against TWO repositories
 * at once, each with its own install; measured while writing this, six
 * of the ten processes it first reported were jest workers in an
 * unrelated repo, which cannot touch this client.
 *
 * ASKS NODE rather than spelling `node_modules` into a path. The first
 * version walked up joining `node_modules` by hand and
 * `tests/guardrails/dependency-paths-are-resolved.test.ts` rejected it,
 * correctly: a literal join does no upward walk and no symlink
 * resolution, so it is wrong in exactly the layout this repo uses — the
 * worktrees reach a single shared install through a SYMLINK, and a
 * checkout that owns no install at all resolves upward to its primary
 * clone. `createRequire(<dir>/noop.js).resolve()` is Node's own
 * resolver answering the only question that matters: which file would
 * this process actually load.
 *
 * `null` means unresolvable (no install reachable from there), which
 * the caller treats as "not mine" only when OUR side resolved.
 */
const clientPathCache = new Map();
function resolvedClientFor(dir) {
    if (clientPathCache.has(dir)) return clientPathCache.get(dir);
    let resolved = null;
    try {
        const req = createRequire(path.join(dir, 'noop.js'));
        resolved = fs.realpathSync(req.resolve('@prisma/client'));
    } catch {
        resolved = null;
    }
    clientPathCache.set(dir, resolved);
    return resolved;
}

/**
 * Is this argv a jest or tsc invocation?
 *
 * Matched on each ARGUMENT'S BASENAME, never as a substring of the
 * whole command line. The first version tested
 * `/\bjest\b/.test(wholeCmdline)` and immediately produced a false
 * "WAIT FIRST" against this script's own grandparent shell, because
 * that shell's argv contained a heredoc that mentions jest in prose.
 * A spurious wait is not a harmless over-count: it is what teaches
 * someone to ignore the one line in this message that stops them
 * breaking a peer's run. (Same family as `pgrep -f` matching its own
 * command line, which this repo's notes already record.)
 */
function classifyReader(argv) {
    for (const arg of argv) {
        const base = arg.split('/').pop() ?? '';
        if (/^jest(\.[cm]?js)?$/.test(base)) return 'jest';
        if (/^tsc(\.[cm]?js)?$/.test(base)) return 'tsc';
        // Worker children do not carry the tool's name in argv[1];
        // without this a 12-worker run is invisible the moment its
        // parent is between files.
        if (arg.includes('jest-worker')) return 'jest';
    }
    return null;
}

/**
 * Best-effort: who is reading the generated client right now.
 *
 * Both kinds matter and the first version of this counted only jest.
 * `generate` rewrites `index.js` AND `index.d.ts`, so a `tsc` holding
 * the type declarations is just as exposed as a jest worker holding the
 * runtime — and in this checkout a peer's `tsc --noEmit` runs for
 * 6-15 minutes, which is a wide window to land in. The cwd is reported
 * with each one because "wait" and "go ahead" are different answers
 * depending on whether the run is yours.
 */
function clientReaders() {
    try {
        // Insurance on top of the basename match: an ancestor of this
        // process is by definition not an independent reader.
        const ancestors = new Set([String(process.pid)]);
        for (let pid = process.ppid, hops = 0; pid > 1 && hops < 32; hops += 1) {
            ancestors.add(String(pid));
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
                pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            } catch {
                break;
            }
        }
        const ours = resolvedClientFor(process.cwd());
        const readers = [];
        for (const entry of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(entry) || ancestors.has(entry)) continue;
            try {
                const argv = fs
                    .readFileSync(`/proc/${entry}/cmdline`, 'utf8')
                    .split('\0')
                    .filter(Boolean);
                const kind = classifyReader(argv);
                if (!kind) continue;
                let cwd = null;
                try {
                    cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
                } catch {
                    /* not ours to inspect */
                }
                // A reader of a DIFFERENT install cannot be harmed by
                // regenerating this one. When the cwd is unreadable the
                // process is not ours to inspect, and the safe reading
                // of "unknown" is to keep it: an unnecessary wait costs
                // seconds, a wrongly-permitted regenerate costs a run.
                if (cwd !== null && ours !== null && resolvedClientFor(cwd) !== ours) continue;
                readers.push({ pid: entry, kind, cwd });
            } catch {
                /* process exited between readdir and read, or not ours */
            }
        }
        return readers;
    } catch {
        return null;
    }
}

function diffSets(schemaSet, clientSet) {
    const missing = [...schemaSet].filter((x) => !clientSet.has(x));
    const extra = [...clientSet].filter((x) => !schemaSet.has(x));
    return { missing, extra };
}

async function main() {
    if (process.env.CI) return 0;
    if (process.env.SKIP_PRISMA_FRESHNESS) return 0;
    if (!fs.existsSync(SCHEMA_DIR)) return 0;

    let client;
    try {
        client = await import('@prisma/client');
    } catch (err) {
        console.error('? prisma client freshness: NOT CHECKED (the generated client would not load)');
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        console.error('  Nothing was compared. If `tsc` reports errors in files you did not touch,');
        console.error('  run `npm run db:generate` before believing them.');
        return 0;
    }
    const dmmf = client.Prisma?.dmmf;
    if (!dmmf?.datamodel) {
        console.error('? prisma client freshness: NOT CHECKED (the client exposes no dmmf)');
        console.error('  Nothing was compared. Treat the result as "unknown", not "fresh".');
        return 0;
    }

    const schema = parseSchema();
    const clientModels = new Map(
        dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.map((f) => f.name))]),
    );
    // Enum values come from the generated RUNTIME EXPORTS, not from the
    // dmmf, and both halves of that sentence were measured.
    //
    // `dmmf.datamodel.enums` is EMPTY in this client — length 0 against
    // 152 enums in the schema, with no `dmmf.schema` to fall back to —
    // so a comparison built on it reports every enum as missing. Worse,
    // a version that special-cased the emptiness would be blind to a
    // missing enum VALUE, which is the exact failure that produced
    // #3310. The runtime export is also what application code imports,
    // so it is the right subject: `client.Role` is an object keyed by
    // its own values.
    //
    // Enumerated from the exports INDEPENDENTLY of the schema rather
    // than by looking up the names the schema mentions, because keying
    // off the schema would make the client-is-AHEAD direction
    // undetectable for enums — the direction that fails silently. The
    // shape test (a plain object whose every value is a string
    // identical to its key) matched exactly 152 exports against 152
    // schema enums, with no false positives.
    const looksLikeEnum = (v) =>
        v
        && typeof v === 'object'
        && !Array.isArray(v)
        && Object.keys(v).length > 0
        && Object.entries(v).every(([k, val]) => typeof val === 'string' && val === k);
    const clientEnums = new Map(
        Object.keys(client)
            .filter((name) => looksLikeEnum(client[name]))
            .map((name) => [name, new Set(Object.keys(client[name]))]),
    );

    if (schema.models.size === 0 && schema.enums.size === 0) {
        console.error('? prisma client freshness: NOT CHECKED (parsed 0 models and 0 enums)');
        console.error(`  ${SCHEMA_DIR} exists but yielded nothing. The parser, not the client,`);
        console.error('  is the suspect. Nothing was compared.');
        return 0;
    }

    const problems = [];
    for (const [label, schemaMap, clientMap] of [
        ['model', schema.models, clientModels],
        ['enum', schema.enums, clientEnums],
    ]) {
        const top = diffSets(new Set(schemaMap.keys()), new Set(clientMap.keys()));
        for (const name of top.missing) problems.push(`${label} ${name} is in the schema and NOT in the client`);
        for (const name of top.extra) problems.push(`${label} ${name} is in the client and NOT in the schema`);
        for (const [name, members] of schemaMap) {
            const clientMembers = clientMap.get(name);
            if (!clientMembers) continue;
            const d = diffSets(members, clientMembers);
            const unit = label === 'enum' ? 'value' : 'field';
            for (const m of d.missing) problems.push(`${label} ${name}.${m}: ${unit} in the schema, NOT in the client`);
            for (const m of d.extra) problems.push(`${label} ${name}.${m}: ${unit} in the client, NOT in the schema`);
        }
    }

    const compared = `${schema.models.size} models / ${schema.enums.size} enums`;
    if (problems.length === 0) {
        console.log(`✓ prisma client freshness: clean — ${compared} compared, all agree.`);
        return 0;
    }

    const behind = problems.filter((p) => p.endsWith('in the client')).length;
    const ahead = problems.length - behind;
    console.error('');
    console.error(`✗ prisma client freshness: the generated client DISAGREES with prisma/schema/.`);
    console.error(`  compared ${compared}; ${behind} thing(s) the client is missing, ${ahead} it has and the schema does not.`);
    console.error('');
    for (const p of problems.slice(0, 12)) console.error(`    ${p}`);
    if (problems.length > 12) console.error(`    … and ${problems.length - 12} more`);
    console.error('');
    console.error('  tsc was NOT run. It would have reported this as type errors in files you did');
    console.error('  not touch, which is indistinguishable from a real defect once printed.');
    try {
        // `.prisma/client` is the GENERATED artefact and the only one
        // whose mtime answers "when was generate last run": the
        // installed `@prisma/client` package's own mtime is its install
        // date and does not move when the client is regenerated.
        const generated = createRequire(import.meta.url).resolve('.prisma/client');
        console.error(`  client last generated: ${fs.statSync(generated).mtime.toISOString()}`);
    } catch {
        /* no generated client on disk to date */
    }
    console.error('');
    console.error('  Fix:  npm run db:generate');
    const readers = clientReaders();
    if (readers === null) {
        console.error('        (could not enumerate processes — check for peer jest/tsc runs first)');
    } else if (readers.length > 0) {
        const here = process.cwd();
        console.error('');
        console.error(`  WAIT FIRST: ${readers.length} process(es) are reading the generated client:`);
        for (const r of readers.slice(0, 6)) {
            const whose = r.cwd === here ? 'this worktree' : (r.cwd ?? 'unknown cwd');
            console.error(`    ${r.kind} pid ${r.pid} — ${whose}`);
        }
        if (readers.length > 6) console.error(`    … and ${readers.length - 6} more`);
        console.error('  `generate` rewrites index.js and index.d.ts in place, so regenerating now');
        console.error('  throws ENOENT inside those runs — including any peer worktree\'s.');
    } else {
        console.error('        (nothing is reading the client, so regenerating is safe right now)');
    }
    console.error('');
    console.error('  To typecheck anyway: SKIP_PRISMA_FRESHNESS=1 npm run typecheck');
    console.error('');
    return 1;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        // A crash in a freshness check must never be the reason a
        // typecheck cannot run. Report and let tsc proceed.
        console.error(`? prisma client freshness: NOT CHECKED (${err instanceof Error ? err.message : String(err)})`);
        process.exit(0);
    },
);
