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
 * ─── The advisory half ──────────────────────────────────────────────
 *
 * The offline guard records, per override, WHICH advisory justifies it
 * and WHICH version fixed that advisory (`advisory` / `patchedFrom` in
 * `tests/guards/override-registry.json`). It can only check the SHAPE
 * of those facts — `/^(GHSA-|CVE-)/` and `x.y.z`. Whether the id is
 * real, describes THIS package, or was actually fixed in the recorded
 * version needs the advisory database, i.e. the network.
 *
 * That gap was live for four entries at once (2026-07-25): `picomatch`
 * carried an id belonging to an `ip` SSRF advisory, `tmp` carried an id
 * that does not exist, and `protobufjs` / `@grpc/grpc-js` carried real
 * advisories whose fixes landed in majors far below the floors they
 * were justifying. Every one was shape-valid and green.
 *
 * So this script reports two further kinds of drift:
 *
 *   ADVISORY — the recorded id does not resolve, does not cover the
 *              package it is filed under, or its real fixed version
 *              disagrees with `patchedFrom`. The registry is lying.
 *
 *   FLOOR    — the override's own floor is a version some advisory
 *              STILL affects. This is the decay that hit `tmp`
 *              (^0.2.6 against an advisory affecting 0.2.6) and
 *              `protobufjs` (^8.2.0 against a fix in 8.6.6): a
 *              follow-up advisory lands on a package already pinned
 *              here, the lockfile happens to sit on something patched,
 *              and `npm audit` stays green while the floor no longer
 *              excludes anything.
 *
 * Non-blocking by design: it exits 0 unless `--strict` is passed. A
 * lagging override is a nudge, not a merge blocker — the `npm audit`
 * gate is what actually blocks, and it does so on evidence of a real
 * advisory rather than on version arithmetic.
 *
 * Usage:
 *   node scripts/check-override-freshness.mjs [--strict] [--json]
 *
 * `GITHUB_TOKEN` is used for the advisory API when present. Without
 * it the endpoint allows 60 requests/hour, which one local run fits
 * inside but a busy CI runner may not — a rate-limited run degrades to
 * `skip` findings rather than false confidence.
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

// ── advisory database ──────────────────────────────────────────────

/**
 * A GitHub advisory range: `>= 4.11.8, < 4.12.27`, `<= 2.0.1`, `< 0.6.0`.
 * Comma- OR space-separated conjunction of comparators.
 *
 * Returns null — never a bare `false` — when a bound is unparseable, so
 * an unrecognised shape reads as "unknown" at the call site instead of
 * silently as "not affected". A false negative here is the whole class
 * of bug this script exists to catch.
 */
function withinAdvisoryRange(version, range) {
    const v = parse(version);
    if (!v) return null;
    const parts = String(range)
        // GitHub writes a space after the comparator (`>= 0.2.6, < 0.2.7`);
        // close it up first or the split hands back bare operators.
        .replace(/(>=|<=|>|<|=)\s+/g, '$1')
        .split(/[,\s]+/)
        .filter(Boolean);
    if (!parts.length) return null;
    let ok = true;
    for (const part of parts) {
        const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
        if (!m) return null;
        const c = cmp(v, parse(m[2]));
        switch (m[1] ?? '=') {
            case '>=': ok &&= c >= 0; break;
            case '<=': ok &&= c <= 0; break;
            case '>': ok &&= c > 0; break;
            case '<': ok &&= c < 0; break;
            default: ok &&= c === 0;
        }
    }
    return ok;
}

async function ghAdvisoryApi(path) {
    const headers = { accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) throw new Error('advisory API rate-limited');
    if (!res.ok) throw new Error(`advisory API ${res.status}`);
    return res.json();
}

/** Resolve a recorded id. GHSA ids address directly; CVEs need a query. */
async function fetchAdvisory(id) {
    if (id.startsWith('GHSA-')) return ghAdvisoryApi(`/advisories/${encodeURIComponent(id)}`);
    const hits = await ghAdvisoryApi(`/advisories?cve_id=${encodeURIComponent(id)}&per_page=1`);
    return Array.isArray(hits) && hits.length ? hits[0] : null;
}

/** Every non-withdrawn npm advisory affecting `name`. */
async function fetchAdvisoriesForPackage(name) {
    const hits = await ghAdvisoryApi(
        `/advisories?ecosystem=npm&affects=${encodeURIComponent(name)}&per_page=100`,
    );
    return (Array.isArray(hits) ? hits : []).filter((a) => !a.withdrawn_at);
}

/** The vulnerability records of `advisory` that concern `name`. */
const entriesFor = (advisory, name) =>
    (advisory?.vulnerabilities ?? []).filter((v) => v.package?.name === name);

/**
 * Which advisories on this package were fixed in exactly `patchedFrom`?
 *
 * A wrong id is otherwise a research task: "this is not the advisory"
 * leaves the reader to go find the one that is. Since the recorded
 * FIXED VERSION is usually right even when the id is wrong (the floor
 * was set from a real audit finding), the advisory whose fix matches
 * that version is almost always the one meant — so name it and the
 * finding becomes a one-line correction.
 */
function advisoriesMatchingFix(pkgAdvisories, name, patchedFrom) {
    const ids = [];
    for (const a of pkgAdvisories) {
        for (const v of entriesFor(a, name)) {
            if (v.first_patched_version === patchedFrom) ids.push(a.ghsa_id);
        }
    }
    return [...new Set(ids)];
}

// ── main ───────────────────────────────────────────────────────────

// ── self-test ──────────────────────────────────────────────────────
//
// Every finding above is only as trustworthy as two hand-rolled
// comparators. A comparator that returned `false` unconditionally
// would report a clean bill of health forever — the exact silent-green
// failure this script was written to end. The offline guard pins its
// own comparator in a "comparator sanity" block; this is that block,
// runnable as `--self-test` so CI can prove the tool works before
// believing what it says.

if (process.argv.includes('--self-test')) {
    const checks = [
        ['floor inside advisory range', withinAdvisoryRange('0.2.6', '>= 0.2.6, < 0.2.7'), true],
        ['floor above advisory range', withinAdvisoryRange('0.2.7', '>= 0.2.6, < 0.2.7'), false],
        ['exclusive upper bound', withinAdvisoryRange('4.12.27', '>= 4.11.8, < 4.12.27'), false],
        ['inside two-sided range', withinAdvisoryRange('4.12.26', '>= 4.11.8, < 4.12.27'), true],
        ['inclusive upper bound', withinAdvisoryRange('2.0.1', '<= 2.0.1'), true],
        ['bare lower bound', withinAdvisoryRange('0.6.0', '< 0.6.0'), false],
        ['space-separated conjunction', withinAdvisoryRange('8.6.5', '>= 8.0.0 <= 8.6.5'), true],
        // Unknown shapes must read as "unknown", never as "not affected".
        ['prerelease bound → unknown', withinAdvisoryRange('1.0.0', '>= 1.0.0-beta.1'), null],
        ['empty range → unknown', withinAdvisoryRange('1.0.0', ''), null],
        ['caret admits patch', satisfiesCaret('4.12.31', '^4.12.27'), true],
        ['caret excludes below floor', satisfiesCaret('4.12.25', '^4.12.27'), false],
        ['caret excludes next major', satisfiesCaret('5.0.0', '^4.12.27'), false],
        ['caret 0.x holds minor', satisfiesCaret('0.3.0', '^0.2.6'), false],
        ['caret 0.x admits patch', satisfiesCaret('0.2.7', '^0.2.6'), true],
    ];
    const failed = checks.filter(([, actual, expected]) => actual !== expected);
    for (const [label, actual, expected] of failed) {
        console.error(`self-test FAILED: ${label} — expected ${expected}, got ${actual}`);
    }
    console.log(`self-test: ${checks.length - failed.length}/${checks.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

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

// ── advisory verification ──────────────────────────────────────────
//
// Runs over EVERY security override, including ones the lockfile
// currently resolves to nothing: an inert floor's facts still have to
// be true, because the floor is what governs the package if it returns.

const registry = readJson('tests/guards/override-registry.json');

for (const o of versionForcingOverrides()) {
    const entry = registry[o.name];
    if (entry?.kind !== 'security' || !entry.advisory || !entry.patchedFrom) continue;

    let advisory;
    let pkgAdvisories;
    try {
        [advisory, pkgAdvisories] = await Promise.all([
            fetchAdvisory(entry.advisory),
            fetchAdvisoriesForPackage(o.name),
        ]);
    } catch (err) {
        findings.push({ level: 'skip', name: o.name, note: `advisory lookup failed: ${err.message}` });
        continue;
    }

    const suggested = advisoriesMatchingFix(pkgAdvisories, o.name, entry.patchedFrom);
    const fix = suggested.length
        ? ` — the ${o.name} advisory fixed in ${entry.patchedFrom} is ${suggested.join(' / ')}`
        : '';

    // 1. Does the recorded id resolve at all?
    if (!advisory) {
        findings.push({
            level: 'advisory',
            name: o.name,
            spec: o.spec,
            advisory: entry.advisory,
            suggested,
            // A CVE lands here too when it is real but not the npm
            // advisory id — e.g. an inherited native-library CVE that
            // GitHub files under a GHSA of its own.
            note: `recorded advisory id does not resolve as an npm advisory${fix}`,
        });
    } else {
        const mine = entriesFor(advisory, o.name);
        if (mine.length === 0) {
            // 2. Real id, wrong package — the `picomatch` → `ip` shape.
            const covers = [...new Set((advisory.vulnerabilities ?? []).map((v) => v.package?.name))];
            findings.push({
                level: 'advisory',
                name: o.name,
                spec: o.spec,
                advisory: entry.advisory,
                suggested,
                note: `recorded advisory does not cover ${o.name} — it affects ${covers.join(', ') || 'nothing in npm'}${fix}`,
            });
        } else {
            // 3. Right package — does any affected line agree with
            //    `patchedFrom`? Advisories routinely patch several
            //    majors, so ANY match is enough.
            const patched = mine.map((v) => v.first_patched_version).filter(Boolean);
            if (!patched.includes(entry.patchedFrom)) {
                findings.push({
                    level: 'advisory',
                    name: o.name,
                    spec: o.spec,
                    advisory: entry.advisory,
                    patchedFrom: entry.patchedFrom,
                    note: `recorded patchedFrom ${entry.patchedFrom} matches no fixed version of this advisory (${patched.join(' / ') || 'none published'})`,
                });
            }
        }
    }

    // 4. Is the floor itself still an affected version? The decay that
    //    hit tmp and protobufjs — a follow-up advisory lands on a
    //    package already pinned, and the floor silently stops excluding.
    const floor = o.spec.startsWith('^') ? o.spec.slice(1) : null;
    if (floor && parse(floor)) {
        for (const a of pkgAdvisories) {
            for (const v of entriesFor(a, o.name)) {
                if (withinAdvisoryRange(floor, v.vulnerable_version_range) !== true) continue;
                findings.push({
                    level: 'floor',
                    name: o.name,
                    spec: o.spec,
                    advisory: a.ghsa_id,
                    severity: a.severity,
                    vulnerableRange: v.vulnerable_version_range,
                    fixedIn: v.first_patched_version,
                    note: `the override floor ${floor} is itself affected by ${a.ghsa_id} (${v.vulnerable_version_range}) — raise the floor to ^${v.first_patched_version}`,
                });
            }
        }
    }
}

if (AS_JSON) {
    console.log(JSON.stringify(findings, null, 2));
} else {
    const lagging = findings.filter((f) => f.level === 'lagging');
    const outside = findings.filter((f) => f.level === 'outside');
    const skipped = findings.filter((f) => f.level === 'skip');
    const advisoryIssues = findings.filter((f) => f.level === 'advisory');
    const floorIssues = findings.filter((f) => f.level === 'floor');

    if (!findings.length) {
        console.log('All version-forcing overrides are at the newest release their range permits, and every recorded advisory checks out.');
    }
    // Registry-correctness first: a lagging lockfile is a nudge, but a
    // registry that records the wrong fact makes every other signal —
    // including the offline guard's — untrustworthy.
    for (const f of floorIssues) {
        console.log(`::error title=Override floor still vulnerable::${f.name} ${f.spec}: ${f.note} [${f.severity}]`);
    }
    for (const f of advisoryIssues) {
        console.log(`::error title=Override advisory wrong::${f.name} (${f.advisory}): ${f.note}`);
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

        if (floorIssues.length || advisoryIssues.length) {
            lines.push('### Registry is wrong about its own facts', '');
            lines.push('| Package | Override | Advisory | Problem |');
            lines.push('|---|---|---|---|');
            for (const f of [...floorIssues, ...advisoryIssues]) {
                lines.push(`| \`${f.name}\` | \`${f.spec}\` | ${f.advisory ?? '—'} | ${f.note} |`);
            }
            lines.push('');
        }

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

// `outside` is informational. A lag, a floor that is itself vulnerable,
// and a registry entry that misstates its advisory are all
// escalation-worthy — but escalation stays opt-in via `--strict`, so
// the scheduled run reports rather than blocks.
const ESCALATES = new Set(['lagging', 'advisory', 'floor']);
process.exit(STRICT && findings.some((f) => ESCALATES.has(f.level)) ? 1 : 0);
