/**
 * Nothing disables the network above a layer that fetches.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `deploy/laya/Dockerfile` shipped with `HF_HUB_OFFLINE=1` in its `ENV` block,
 * four layers above the `RUN` that calls `snapshot_download`. So the one layer
 * whose job was to reach the Hub was the one layer forbidden from doing so, and
 * the image had no successful build path at all:
 *
 *     LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder
 *     for the specified revision on the local disk and outgoing traffic has been
 *     disabled.
 *
 * Reproduced and then fixed under `docker build`, both directions, before this
 * guard was written: offline-above fails at the fetch layer; offline-below
 * builds, bakes the checkpoint in, and still reports `HF_HUB_OFFLINE` true at
 * runtime — which is the property the flag was there for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A STATIC GUARD AND NOT A BUILD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Building the real image pulls torch and about a gigabyte of weights, so it is
 * not a per-pull-request check. This guard is narrower on purpose: it catches
 * the ORDERING class, which is the one that recurs, because the tempting edit is
 * to group the `ENV`s together and that edit is exactly the bug.
 *
 * It does NOT prove buildability in general — a bad pip pin or a removed apt
 * package would still reach a dispatch unseen.
 *
 * THAT GAP IS NOW CLOSED ELSEWHERE, and the sentence that used to sit here
 * ("the honest check for that is a path-scoped build ... which is the owner's
 * call") was answered on 2026-10-11: `ci.yml`'s `laya-image` job builds this
 * Dockerfile on pull requests touching `deploy/laya/**`, starts the container,
 * and waits for the Dockerfile's own HEALTHCHECK. It had to go further than a
 * build, because the two defects found after this guard was written were
 * neither of them build-time failures: #3420 was a HEALTHCHECK pointed at a
 * path the server does not serve, and #3421 was a server that exits during
 * `create_app()` because it reads a different repo than the one baked.
 *
 * This guard stays, and is not redundant: it runs on every pull request in
 * seconds and names the ordering class precisely, where the build job runs only
 * on this path and takes tens of minutes.
 *
 * `--build-arg` is no escape hatch, which is why this is worth a guard rather
 * than a code review note: the flag is an `ENV`, and `--build-arg` only reaches
 * a declared `ARG`. A file in this state cannot be rescued from outside.
 *
 * @module guardrails/dockerfile-offline-ordering
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

/**
 * Environment variables that forbid outgoing traffic for some tool.
 *
 * Each one is a real flag with this failure shape, not a guess at a pattern:
 * set it above a layer that fetches and the build dies there.
 */
const OFFLINE_VARS = [
    'HF_HUB_OFFLINE',
    'TRANSFORMERS_OFFLINE',
    'HF_DATASETS_OFFLINE',
    'PIP_NO_INDEX',
    'NPM_CONFIG_OFFLINE',
    'YARN_ENABLE_NETWORK',
] as const;

/** Commands that reach the network inside a `RUN`. */
const FETCHING = [
    'snapshot_download',
    'hf_hub_download',
    'from_pretrained',
    'pip install',
    'pip3 install',
    'npm install',
    'npm ci',
    'apt-get update',
    'apt-get install',
    'curl ',
    'wget ',
    'git clone',
] as const;

interface Line {
    readonly n: number;
    readonly text: string;
}

export interface OfflineFinding {
    readonly file: string;
    readonly variable: string;
    readonly setAt: number;
    readonly fetchAt: number;
    readonly fetchText: string;
}

/**
 * Every place a network-disabling ENV precedes a fetching RUN in one file.
 *
 * Reads only `ENV` and `RUN` instructions, and ignores a value of `0` or
 * `false` — `YARN_ENABLE_NETWORK=1` enables the network, so the list above
 * needs the VALUE read rather than the name matched.
 */
export function offlineBeforeFetch(text: string, file: string): readonly OfflineFinding[] {
    // PARSE INSTRUCTIONS, NOT LINES. The first draft matched line by line and had
    // both failure directions at once: it read the HEALTHCHECK's `curl` as a
    // build-time fetch (a false alarm on the very file it was written for), and it
    // missed `ENV HF_HOME=/opt/hf HF_HUB_OFFLINE=1`, because the variable was
    // neither at the start of the line nor directly after `ENV`. Joining
    // backslash continuations into one logical instruction, and keeping the
    // keyword that opened it, fixes both.
    const instructions: { keyword: string; body: string; line: number }[] = [];
    const raw = text.split('\n');
    let i = 0;
    while (i < raw.length) {
        const stripped = (raw[i] ?? '').replace(/\s+#.*$/, '');
        if (/^\s*#/.test(raw[i] ?? '') || stripped.trim() === '') {
            i += 1;
            continue;
        }
        const startLine = i + 1;
        let joined = stripped;
        while (/\\\s*$/.test(joined) && i + 1 < raw.length) {
            i += 1;
            joined = joined.replace(/\\\s*$/, ' ') + (raw[i] ?? '').replace(/\s+#.*$/, '');
        }
        const kw = (/^\s*([A-Za-z]+)\s/.exec(joined)?.[1] ?? '').toUpperCase();
        instructions.push({ keyword: kw, body: joined, line: startLine });
        i += 1;
    }

    const disabled: { variable: string; setAt: number }[] = [];
    const out: OfflineFinding[] = [];

    for (const inst of instructions) {
        if (inst.keyword === 'ENV') {
            for (const v of OFFLINE_VARS) {
                // Anywhere in the instruction, since one ENV may set several.
                const m = new RegExp(`\\b${v}[= ]\\s*([^\\s\\\\]+)`, 'i').exec(inst.body);
                if (!m) continue;
                const value = m[1].toLowerCase();
                const zero = value === '0' || value === 'false';
                // YARN_ENABLE_NETWORK is the one whose DISABLING value is 0, so
                // the value has to be read rather than the name matched.
                const off = v === 'YARN_ENABLE_NETWORK' ? zero : !zero;
                if (off) disabled.push({ variable: v, setAt: inst.line });
            }
            continue;
        }
        // ONLY `RUN` fetches at build time. A HEALTHCHECK's or CMD's `curl` runs in
        // the finished container against localhost, which is not a build step and
        // is exactly the false alarm this guard produced first time out.
        if (inst.keyword !== 'RUN') continue;
        const hit = FETCHING.find((f) => inst.body.toLowerCase().includes(f.toLowerCase()));
        if (!hit) continue;
        for (const d of disabled) {
            out.push({ file, variable: d.variable, setAt: d.setAt, fetchAt: inst.line, fetchText: hit.trim() });
        }
    }
    return out;
}

function dockerfiles(): readonly string[] {
    return repoRelativeFiles().filter((f) => /(^|\/)Dockerfile($|\.)/.test(f));
}

describe('Dockerfiles — nothing disables the network above a layer that fetches', () => {
    const files = dockerfiles();

    it('finds the Dockerfile population at all', () => {
        // The denominator beside the result: a scan that found nothing would
        // pass the assertion below over an empty set.
        expect(files.length).toBeGreaterThanOrEqual(2);
        expect(files).toContain('deploy/laya/Dockerfile');
    });

    it('no Dockerfile sets an offline flag above a fetch', () => {
        const findings = files.flatMap((f) =>
            offlineBeforeFetch(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), f),
        );
        expect(
            findings.map(
                (x) => `${x.file}: ${x.variable} set at line ${x.setAt} precedes "${x.fetchText}" at line ${x.fetchAt}`,
            ),
        ).toEqual([]);
    });

    describe('detector proof — on synthetic Dockerfiles, so a clean run means something', () => {
        it('flags the exact shape that shipped', () => {
            const bad = [
                'FROM python:3.12-slim',
                'ENV HF_HOME=/opt/hf HF_HUB_OFFLINE=1',
                'RUN pip install --no-cache-dir huggingface_hub',
                'RUN python -c "snapshot_download(\'org/model\')"',
            ].join('\n');
            const found = offlineBeforeFetch(bad, 'synthetic');
            expect(found.length).toBeGreaterThan(0);
            expect(found[0].variable).toBe('HF_HUB_OFFLINE');
        });

        it('accepts the fixed ordering — offline BELOW the fetch', () => {
            const good = [
                'FROM python:3.12-slim',
                'ENV HF_HOME=/opt/hf',
                'RUN pip install --no-cache-dir huggingface_hub',
                'RUN python -c "snapshot_download(\'org/model\')"',
                'ENV HF_HUB_OFFLINE=1',
            ].join('\n');
            expect(offlineBeforeFetch(good, 'synthetic')).toEqual([]);
        });

        it('reads the VALUE, so an explicit 0 is not a disable', () => {
            // `HF_HUB_OFFLINE=0` is the default state spelled out. Flagging it
            // would be noise, and noise is what gets a guard deleted.
            const zero = [
                'FROM python:3.12-slim',
                'ENV HF_HUB_OFFLINE=0',
                'RUN python -c "snapshot_download(\'org/model\')"',
            ].join('\n');
            expect(offlineBeforeFetch(zero, 'synthetic')).toEqual([]);
        });

        it('reads YARN_ENABLE_NETWORK in the opposite direction', () => {
            // The one variable in the list whose DISABLING value is 0. Matching
            // the name alone would get this backwards in both directions.
            const off = 'FROM node:24-alpine\nENV YARN_ENABLE_NETWORK=0\nRUN npm ci';
            const on = 'FROM node:24-alpine\nENV YARN_ENABLE_NETWORK=1\nRUN npm ci';
            expect(offlineBeforeFetch(off, 'synthetic').length).toBeGreaterThan(0);
            expect(offlineBeforeFetch(on, 'synthetic')).toEqual([]);
        });

        it('ignores a commented-out ENV', () => {
            const commented = [
                'FROM python:3.12-slim',
                '# ENV HF_HUB_OFFLINE=1',
                'RUN python -c "snapshot_download(\'org/model\')"',
            ].join('\n');
            expect(offlineBeforeFetch(commented, 'synthetic')).toEqual([]);
        });

        it('catches a continued ENV block, which is how the real one was written', () => {
            // The shipped bug was a backslash-continued block, not a one-liner.
            const continued = [
                'FROM python:3.12-slim',
                'ENV PYTHONUNBUFFERED=1 \\',
                '    HF_HOME=/opt/hf \\',
                '    HF_HUB_OFFLINE=1 \\',
                '    LAYA_PORT=8000',
                'RUN python -c "snapshot_download(\'org/model\')"',
            ].join('\n');
            expect(offlineBeforeFetch(continued, 'synthetic').length).toBeGreaterThan(0);
        });
    });
});
