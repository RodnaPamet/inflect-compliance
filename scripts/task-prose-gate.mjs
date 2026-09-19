#!/usr/bin/env node
/**
 * Deterministic quality gate for authored control-task prose.
 *
 * WHAT IT IS FOR. Two rounds of agent-authored task content were rejected by
 * adversarial review for boilerplate that every existing guard passed:
 * roughly a quarter of titles would have sat correctly under a different
 * control, sentence frames were reused with the nouns swapped, and one title
 * carried no noun from its own subject area at all. The repo's guards cannot
 * see any of that — `control-task-actionability` checks structure (>=3 tasks,
 * >=3 phases, exact-duplicate titles), not distinctiveness.
 *
 * This is the check that DID catch things when applied by hand: similarity
 * against every existing title in the target fixture, leading-verb piling, and
 * shared sentence frames. Run it BEFORE writing a fixture, not after.
 *
 * USAGE
 *   node scripts/task-prose-gate.mjs <fixture.json> <candidates.json>
 *
 *   candidates.json: [{ "code": "PRIV-13.1", "title": "...", "phase": "SCOPE",
 *                       "evidenceHint": "...", "description": "..." }, ...]
 *
 * Exit 0 = clean, 1 = rejections. Findings print one per line.
 */
import fs from 'node:fs';

// CALIBRATED AGAINST MEASURED CASES, not guessed. The first setting rejected
// 5 of 21 drafts and 4 were noise: in a narrow domain, titles necessarily
// share vocabulary ("privacy", "individual", "processing", "data"), which
// inflates bigram overlap without any reuse of structure. Measured shared
// word-runs for those four: 'privacy', 'the', 'by which', 'and' — 1 to 2
// words. The draft a human rejected for genuine frame reuse shared FIVE
// ('trace a sample of shipped').
//
// So the SHARED RUN is the discriminator and similarity is the noisy one.
// Dice is kept, raised to fire only on near-duplicates that the run check
// could still miss (e.g. heavy reordering).
const SIMILARITY_REJECT = 0.72;  // near-duplicate only; 0.60 fired on domain vocabulary
const FRAME_MIN_WORDS = 4;       // known-bad shares 5; worst false positive shares 2
const HINT_RUN_WORDS = 5;        // an evidenceHint echoing 5+ words of its title
const VERB_PILE_SHARE = 0.15;    // a leading verb already >15% of the file

// MIRRORED FROM tests/guardrails/control-task-conformance.test.ts, because a
// gate that runs BEFORE the write should enforce everything the guard enforces
// after it. The CM slice passed this gate, then failed that suite in CI on
// "Maintain a current holder…" — `maintain` names a state with nothing to
// finish, so a task opening with it can never be marked done. Every rule that
// file checks on a title is now checked here too, at the point it is cheap.
const UNFINISHABLE_OPENERS = ['ensure', 'maintain', 'be ', 'remain', 'continue', 'keep'];
const MIN_TASKS = 3;
const MAX_TASKS = 6;

/** Dice coefficient over bigrams — cheap, and stable for short titles. */
function similarity(a, b) {
    const grams = (s) => {
        const t = s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
        const out = new Set();
        for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
        return out;
    };
    const A = grams(a), B = grams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const g of A) if (B.has(g)) hit++;
    return (2 * hit) / (A.size + B.size);
}

/** Longest shared word-run between two titles, as a proxy for a reused frame. */
function sharedRun(a, b) {
    const x = a.toLowerCase().split(/\s+/), y = b.toLowerCase().split(/\s+/);
    let best = [];
    for (let i = 0; i < x.length; i++) {
        for (let j = 0; j < y.length; j++) {
            let k = 0;
            while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
            if (k > best.length) best = x.slice(i, i + k);
        }
    }
    return best;
}

const [, , fixturePath, candidatePath] = process.argv;
if (!fixturePath || !candidatePath) {
    console.error('usage: task-prose-gate.mjs <fixture.json> <candidates.json>');
    process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
const candidates = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));

/** Every task title already in the fixture, with the control it belongs to. */
const existing = [];
for (const t of fixture.templates ?? []) {
    for (const k of t.tasks ?? []) {
        const title = typeof k.title === 'string' ? k.title : k.title?.en;
        if (title) existing.push({ code: t.code, title });
    }
}

// POSITIVE CONTROL. An empty corpus would make every check below pass by
// vacuity, which is the failure mode this whole file exists to avoid.
if (existing.length === 0) {
    console.error(`GATE ABORTED: no existing task titles parsed from ${fixturePath}.`);
    console.error('An empty corpus passes every check. Fix the parse before trusting a green run.');
    process.exit(2);
}

const verbCounts = new Map();
for (const e of existing) {
    const v = e.title.split(/\s+/)[0];
    verbCounts.set(v, (verbCounts.get(v) ?? 0) + 1);
}

const findings = [];
const seen = new Map(); // candidate titles, to catch collisions within the batch

for (const c of candidates) {
    const title = typeof c.title === 'string' ? c.title : c.title?.en;
    if (!title) { findings.push(`${c.code}: task has no title`); continue; }

    // 1. exact collision — against the fixture AND against this batch
    const clash = existing.find((e) => e.title === title);
    if (clash) findings.push(`${c.code}: EXACT collision with ${clash.code} — "${title}"`);
    if (seen.has(title)) findings.push(`${c.code}: EXACT collision with ${seen.get(title)} in this batch — "${title}"`);
    seen.set(title, c.code);

    // 2. similarity — the check that caught the 0.63 draft
    let worst = { score: 0, against: null };
    for (const e of existing) {
        const s = similarity(title, e.title);
        if (s > worst.score) worst = { score: s, against: e };
    }
    for (const [other, code] of seen) {
        if (other === title) continue;
        const s = similarity(title, other);
        if (s > worst.score) worst = { score: s, against: { code, title: other } };
    }
    if (worst.score >= SIMILARITY_REJECT) {
        findings.push(
            `${c.code}: ${worst.score.toFixed(2)} similar to ${worst.against.code} — ` +
            `"${title}" vs "${worst.against.title}"`,
        );
    }

    // 3. reused sentence frame — a long shared word-run with nouns swapped
    for (const e of existing) {
        const run = sharedRun(title, e.title);
        if (run.length >= FRAME_MIN_WORDS) {
            findings.push(`${c.code}: shares the run "${run.join(' ')}" with ${e.code}`);
            break;
        }
    }

    // 4. leading-verb piling
    const verb = title.split(/\s+/)[0];
    const share = (verbCounts.get(verb) ?? 0) / existing.length;
    if (share > VERB_PILE_SHARE) {
        findings.push(
            `${c.code}: leading verb "${verb}" already opens ` +
            `${verbCounts.get(verb)}/${existing.length} titles (${(share * 100).toFixed(0)}%)`,
        );
    }

    // 5. evidenceHint that merely restates the title
    //
    // Measured by shared RUN, not similarity, for the same reason as above: a
    // good hint names the artifact and necessarily reuses the subject's nouns.
    // "Issue log for the period: each report despatched with its date…" was
    // rejected by the similarity form and is a perfectly good hint.
    const ev = typeof c.evidenceHint === 'string' ? c.evidenceHint : c.evidenceHint?.en;
    if (ev && sharedRun(ev, title).length >= HINT_RUN_WORDS) {
        findings.push(`${c.code}: evidenceHint echoes its title — "${ev}"`);
    }

    // 6. description no longer than the title says nothing extra
    const desc = typeof c.description === 'string' ? c.description : c.description?.en;
    if (desc && desc.length <= title.length) {
        findings.push(`${c.code}: description is not longer than its title`);
    }

    // 7. a title that names a STATE has no completion — you cannot finish
    //    "maintain the register". Mirrors control-task-conformance.
    const lower = title.toLowerCase().trim();
    const opener = UNFINISHABLE_OPENERS.find((o) => lower.startsWith(o));
    if (opener) {
        findings.push(`${c.code}: opens with "${opener.trim()}" — a state, not an act, so it has no observable completion`);
    }

    // 8. an OPERATE task must name the artifact it produces
    if (c.phase === 'OPERATE' && !ev) {
        findings.push(`${c.code}: OPERATE task with no evidenceHint`);
    }
}

// 9. per-control task counts, including the tasks already on the control.
//    `keptCount` may be supplied by the caller; absent, only the batch counts.
const perControl = new Map();
for (const c of candidates) {
    const n = (perControl.get(c.code) ?? 0) + 1;
    perControl.set(c.code, n);
}
for (const [code, n] of perControl) {
    const kept = candidates.find((c) => c.code === code)?.keptCount ?? 0;
    const total = n + kept;
    if (total < MIN_TASKS) findings.push(`${code}: ${total} tasks, below the ${MIN_TASKS} minimum`);
    if (total > MAX_TASKS) findings.push(`${code}: ${total} tasks, above the ${MAX_TASKS} maximum`);
}

console.log(`corpus: ${existing.length} existing titles from ${fixturePath}`);
console.log(`checked: ${candidates.length} candidates`);
if (findings.length === 0) {
    console.log('GATE PASSED — no rejections');
    process.exit(0);
}
console.log(`GATE REJECTED ${findings.length}:`);
for (const f of findings) console.log(`  ${f}`);
process.exit(1);
