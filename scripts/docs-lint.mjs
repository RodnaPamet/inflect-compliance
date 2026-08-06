#!/usr/bin/env node
/**
 * docs:lint — advisory documentation-index checks.
 *
 * NOT WIRED INTO CI, DELIBERATELY. These checks answer "is the doc index
 * still complete?", which is a question about prose. Gating CI on it was
 * actively harmful: `tests/guards/rq3-11-capstone.test.ts` required every
 * `rq3-*.test.ts` filename to appear as a substring in a markdown file, so
 * shipping an RQ3 follow-up made CI red until the filename was pasted into
 * the doc — and since the convention also asked for a ratchet per PR, the
 * cheapest path to green was writing another ratchet. The loop rewarded
 * exactly the thing it should have discouraged.
 *
 * It also verified MENTION, not accuracy: a row describing behaviour that
 * had since changed passed, because the filename was still spelled there.
 *
 * So this reports, and a human decides. Run it when you touch an indexed
 * cohort. Exit code is always 0 unless a path it needs is missing entirely.
 *
 *   node scripts/docs-lint.mjs      (or: npm run docs:lint)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Doc indexes that name a cohort of files, and how to find that cohort. */
const INDEXES = [
    {
        label: 'RQ3 roadmap capstone',
        doc: 'docs/rq3-roadmap-complete.md',
        cohorts: [
            {
                what: 'implementation notes',
                dir: 'docs/implementation-notes',
                match: /^2026-06-(11|12|13)-rq3-.*\.md$/,
                // The capstone indexes the cohort, not itself.
                skip: ['2026-06-13-rq3-11-capstone.md'],
            },
        ],
    },
];

let findings = 0;

for (const index of INDEXES) {
    const docPath = path.join(ROOT, index.doc);
    if (!existsSync(docPath)) {
        console.error(`✗ ${index.label}: ${index.doc} does not exist`);
        process.exit(1);
    }
    const doc = readFileSync(docPath, 'utf8');

    for (const cohort of index.cohorts) {
        const dir = path.join(ROOT, cohort.dir);
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
            .filter((f) => cohort.match.test(f))
            .filter((f) => !(cohort.skip ?? []).includes(f))
            .sort();
        const missing = files.filter((f) => !doc.includes(f));
        if (missing.length === 0) {
            console.log(`✓ ${index.label}: all ${files.length} ${cohort.what} are named in ${index.doc}`);
        } else {
            findings += missing.length;
            console.log(`• ${index.label}: ${missing.length} ${cohort.what} not named in ${index.doc}`);
            for (const m of missing) console.log(`    ${cohort.dir}/${m}`);
            console.log('  Add them to the index, or leave them out on purpose — this is advisory.');
        }
    }
}

console.log(
    findings === 0
        ? '\ndocs:lint — no gaps.'
        : `\ndocs:lint — ${findings} advisory finding(s). Not a build failure.`,
);
