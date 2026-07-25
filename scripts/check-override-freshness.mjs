#!/usr/bin/env node
/**
 * Override freshness — does each `overrides` entry still point at the
 * CURRENT fix?
 *
 * The offline half of this contract lives in
 * `tests/guards/overrides-effective.test.ts`: it proves every override
 * is registered, forces its recorded patched floor, and actually
 * rewrites every resolved instance. What it structurally cannot know is
 * whether a NEWER patched release exists upstream — that needs the
 * registry, i.e. the network, which a Jest guard must not touch.
 *
 * That blind spot is exactly how `hono` decayed: pinned `^4.12.23`, a
 * range which happily ADMITTED the patched 4.12.31, but the lockfile
 * was never refreshed so the tree sat on vulnerable 4.12.25. Every
 * offline signal said "remediated". The only thing that would have
 * caught it is asking npm what the newest matching version is and
 * noticing the lockfile was behind.
 *
 * So this script reports two distinct kinds of drift:
 *
 *   LAGGING — a newer version EXISTS INSIDE the override's range but
 *             the lockfile hasn't picked it up. This is the hono shape.
 *             Fix: `npm update <pkg>` and commit the lockfile.
 *
 *   OUTSIDE — the newest release sits OUTSIDE the range (usually a new
 *             major). Not automatically actionable — the floor may be
 *             deliberate — but worth a human look, because a fix that
 *             landed only on the new major means the override is no
 *             longer a patch.
 *
 * Non-blocking by design: it exits 0 unless `--strict` is passed. A
 * lagging override is a nudge, not a merge blocker — the `npm audit`
 * gate is what actually blocks, and it does so on evidence of a real
 * advisory rather than on version arithmetic.
 *
 * Usage:
 *   node scripts/check-override-freshness.mjs [--strict] [--json]
 */
import { readFileSync } from 'node:fs';

const STRICT = process.argv.includes('--strict');
const AS_JSON = process.argv.includes('--json');

const readJson = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

// ── semver helpers (same shapes as the offline guard) ───────────────

const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/** Only `^X.Y.Z` — the shape every version-forcing override uses. */
function satisfiesCaret(version, range) {
    if (!range.startsWith('^')) return null; // unknown shape → skip
    const v = parse(version);
    const base = parse(range.slice(1));
    if (!v || !base) return null;
    if (cmp(v, base) < 0) return false;
    const upper = base[0] !== 0
        ? [base[0] + 1, 0, 0]
        : base[1] !== 0
            ? [0, base[1] + 1, 0]
            : [0, 0, base[2] + 1];
    return cmp(v, upper) < 0;
}

// ── inputs ─────────────────────────────────────────────────────────

function versionForcingOverrides() {
    const pkg = readJson('package.json');
    const out = [];
    for (const [key, value] of Object.entries(pkg.overrides ?? {})) {
        if (typeof value !== 'string' || value.startsWith('$')) continue;
        const at = key.lastIndexOf('@');
        const scopedOnly = key.startsWith('@') && at === 0;
        const name = at > 0 && !scopedOnly ? key.slice(0, at) : key;
        out.push({ name, key, spec: value });
    }
    return out;
}

/**
 * The version actually installed, ignoring npm's bundled tree (an
 * override cannot rewrite bundled deps, so a version in there says
 * nothing about whether the override is current).
 */
function lockedVersions(lock, name) {
    const suffix = `node_modules/${name}`;
    const found = new Set();
    for (const [p, meta] of Object.entries(lock.packages ?? {})) {
        if (p.startsWith('node_modules/npm/node_modules/')) continue;
        if ((p === suffix || p.endsWith(`/${suffix}`)) && meta?.version) found.add(meta.version);
    }
    return [...found];
}

async function fetchVersions(name) {
    // `abbreviated` metadata — a fraction of the payload of the full doc.
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
    const body = await res.json();
    return Object.keys(body.versions ?? {}).filter((v) => parse(v)); // drop prereleases
}

// ── main ───────────────────────────────────────────────────────────

const lock = readJson('package-lock.json');
const findings = [];

for (const o of versionForcingOverrides()) {
    const locked = lockedVersions(lock, o.name);
    if (locked.length === 0) continue; // inert override — the offline guard governs these

    let available;
    try {
        available = await fetchVersions(o.name);
    } catch (err) {
        findings.push({ level: 'skip', name: o.name, note: `registry lookup failed: ${err.message}` });
        continue;
    }

    const inRange = available.filter((v) => satisfiesCaret(v, o.spec) === true);
    const newestInRange = inRange.sort((a, b) => cmp(parse(a), parse(b))).at(-1);
    const newestOverall = available.sort((a, b) => cmp(parse(a), parse(b))).at(-1);
    const newestLocked = locked.sort((a, b) => cmp(parse(a), parse(b))).at(-1);

    if (newestInRange && newestLocked && cmp(parse(newestLocked), parse(newestInRange)) < 0) {
        findings.push({
            level: 'lagging',
            name: o.name,
            spec: o.spec,
            locked: newestLocked,
            newestInRange,
            note: `lockfile is behind a version the override already permits — run \`npm update ${o.name}\``,
        });
    } else if (newestOverall && newestInRange && cmp(parse(newestOverall), parse(newestInRange)) > 0) {
        findings.push({
            level: 'outside',
            name: o.name,
            spec: o.spec,
            locked: newestLocked,
            newestInRange,
            newestOverall,
            note: 'a newer release exists outside the override range — check whether the fix moved past the pinned major',
        });
    }
}

if (AS_JSON) {
    console.log(JSON.stringify(findings, null, 2));
} else {
    const lagging = findings.filter((f) => f.level === 'lagging');
    const outside = findings.filter((f) => f.level === 'outside');
    const skipped = findings.filter((f) => f.level === 'skip');

    if (!findings.length) {
        console.log('All version-forcing overrides are at the newest release their range permits.');
    }
    for (const f of lagging) {
        console.log(`::warning title=Override lagging::${f.name} ${f.spec}: locked ${f.locked}, ${f.newestInRange} available in range — ${f.note}`);
    }
    for (const f of outside) {
        console.log(`::notice title=Override floor may be stale::${f.name} ${f.spec}: newest in range ${f.newestInRange}, newest overall ${f.newestOverall} — ${f.note}`);
    }
    for (const f of skipped) {
        console.log(`::notice title=Override check skipped::${f.name} — ${f.note}`);
    }

    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        const { appendFileSync } = await import('node:fs');
        const lines = ['## Override freshness', ''];
        if (!lagging.length && !outside.length) {
            lines.push('Every version-forcing override is at the newest release its range permits.');
        } else {
            lines.push('| Package | Override | Locked | Newest in range | Newest overall | State |');
            lines.push('|---|---|---|---|---|---|');
            for (const f of [...lagging, ...outside]) {
                lines.push(`| \`${f.name}\` | \`${f.spec}\` | ${f.locked} | ${f.newestInRange ?? '—'} | ${f.newestOverall ?? '—'} | ${f.level} |`);
            }
        }
        appendFileSync(summary, lines.join('\n') + '\n');
    }
}

// `outside` is informational; only a genuine lag is escalation-worthy,
// and even then only when explicitly asked to be strict.
process.exit(STRICT && findings.some((f) => f.level === 'lagging') ? 1 : 0);
