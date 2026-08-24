#!/usr/bin/env node
/**
 * Gate: the release-notes generator can actually RENDER.
 *
 * Why this exists. semantic-release runs only on `main`, and only does real
 * work when a commit actually cuts a release. So a dependency bump that
 * breaks changelog rendering passes every PR check, lands green, and then
 * stays invisible until the next `fix:`/`feat:` commit — at which point the
 * release pipeline is already broken on `main`.
 *
 * That is not hypothetical. #2120 bumped
 * conventional-changelog-conventionalcommits 10.3.0 -> 10.4.0, moving the
 * preset onto @conventional-changelog/template@1.4.0. That version adds
 * createLegacyWriterGuard(): a `mainTemplate` which is a handlebars segment
 * literal naming a nonexistent helper. conventional-changelog-writer@9+
 * ignores it; the writer@8 that @semantic-release/release-notes-generator@14
 * depends on renders it and throws `Missing helper`. The break sat latent
 * through four main commits and surfaced on #2118.
 *
 * This gate renders one synthetic commit through the REAL plugin, with the
 * REAL .releaserc.json config, against the RESOLVED node_modules — so it
 * fails on the PR that introduces the incompatibility rather than on main.
 *
 * It deliberately does not stub the preset: the whole failure mode lives in
 * which package version the resolver picks, so a stub would test nothing.
 */
import { readFileSync } from 'node:fs';
import { generateNotes } from '@semantic-release/release-notes-generator';

const cfg = JSON.parse(readFileSync(new URL('../.releaserc.json', import.meta.url), 'utf8'));

const entry = (cfg.plugins || []).find(
    (p) => p === '@semantic-release/release-notes-generator'
        || (Array.isArray(p) && p[0] === '@semantic-release/release-notes-generator'),
);
if (!entry) {
    console.error('[release-notes] FATAL: .releaserc.json has no @semantic-release/release-notes-generator plugin.');
    console.error('[release-notes] If it was removed on purpose, remove this gate in the same commit.');
    process.exit(1);
}
const pluginConfig = Array.isArray(entry) ? (entry[1] ?? {}) : {};

const context = {
    cwd: process.cwd(),
    env: {},
    options: { repositoryUrl: 'https://github.com/RodnaPamet/inflect-compliance.git' },
    lastRelease: { gitTag: 'v1.0.0', version: '1.0.0' },
    nextRelease: { gitTag: 'v1.0.1', version: '1.0.1', type: 'patch' },
    commits: [
        {
            hash: '0123456789abcdef0123456789abcdef01234567',
            message: 'fix(scope): a released change\n',
            subject: 'a released change',
            author: { name: 'ci', email: 'ci@example.com' },
            committerDate: '2026-01-01',
        },
        {
            hash: 'fedcba9876543210fedcba9876543210fedcba98',
            message: 'feat(scope): another released change\n\nBREAKING CHANGE: shape moved.\n',
            subject: 'another released change',
            author: { name: 'ci', email: 'ci@example.com' },
            committerDate: '2026-01-01',
        },
    ],
    logger: { log() {}, error() {}, warn() {}, success() {} },
};

let notes;
try {
    notes = await generateNotes(pluginConfig, context);
} catch (err) {
    console.error('[release-notes] FATAL: generateNotes threw — semantic-release cannot cut a release.');
    console.error(`[release-notes] ${err?.message ?? err}`);
    console.error('[release-notes] Most likely a changelog-tooling version mismatch. Check that the');
    console.error('[release-notes] resolved @conventional-changelog/template matches the writer major');
    console.error('[release-notes] that @semantic-release/release-notes-generator depends on.');
    process.exit(1);
}

// The guard renders INTO the output rather than throwing on some writer
// versions, so an exception is not the only failure shape to refuse.
const GUARD = /Missing helper|requires conventional-changelog-writer@\d/;
if (GUARD.test(notes)) {
    console.error('[release-notes] FATAL: the changelog rendered a tooling guard instead of notes:');
    console.error(notes.slice(0, 400));
    process.exit(1);
}
if (!notes || !notes.includes('1.0.1')) {
    console.error('[release-notes] FATAL: notes did not render the next version. Got:');
    console.error(JSON.stringify(notes));
    process.exit(1);
}

console.log('[release-notes] OK — notes render (' + notes.length + ' chars)');
