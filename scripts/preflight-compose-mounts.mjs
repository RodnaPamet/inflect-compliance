#!/usr/bin/env node
/**
 * Refuse a compose stack whose bind-mount sources are not there — #3965.
 *
 * ═══ THE FAILURE THIS EXISTS FOR ═══
 *
 * A bind mount whose source is missing does NOT fail. Docker creates an empty
 * DIRECTORY at the source path and mounts that, so the daemon starts and finds
 * a directory where its key should be. `pipelock` proved it: its Ed25519
 * private key is bind-mounted from `./pipelock-signing.key`, and with the file
 * absent the service would have come up holding a directory.
 *
 * Nothing available short of running the stack catches it.
 * `docker compose config` validates syntax and `env_file:` presence and says
 * nothing about bind-mount sources. The same blindness is not unique to Docker:
 * OpenShell's own `openshell-gateway config preflight` exits 0 for a
 * `signing_key_path` and a `guest_tls_ca` that do not exist (measured
 * 2026-10-25), so "the platform will catch it" is false in both stacks.
 *
 * ═══ WHY "MUST EXIST" RATHER THAN A CLEVERER RULE ═══
 *
 * Existence alone removes Docker's substitution entirely, for every mount, with
 * no guess about what a mount is "meant" to be. The second check — a
 * file-shaped source must be a regular FILE — catches the case existence
 * cannot: somebody pre-created the directory, by hand or by an earlier `up`
 * that already did this to them. Both failures name the path, because the
 * operator's next action is to put a file there.
 *
 * Named volumes, absolute paths outside the repo and `$VAR` sources are not
 * checked and are reported as skipped, so the output states its own coverage
 * rather than implying it looked at everything.
 *
 * ═══ RUN IT WHERE THE STACK RUNS, NOT IN THE REPOSITORY ═══
 *
 * Relative sources resolve against the directory the compose file sits in AT
 * RUNTIME, and for the canonical stack that is `/opt/inflect/` — a directory
 * `deploy/apply.sh` assembles from several repository locations
 * (`prisma.config.ts` from the root, `init-roles.sh` and `caddy/` from
 * `deploy/`). So no single repository directory makes those mounts resolve, and
 * running this against `deploy/docker-compose.prod.yml` from a checkout reports
 * problems that are not problems. Pass `--base` to say where the compose will
 * actually live, and prefer running it on the host as the step before `up`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A bind mount we can check: a relative host path, so it resolves inside the deploy dir. */
const isCheckableSource = (src) =>
    src.startsWith('./') || src.startsWith('../');

/**
 * Parse `volumes:` entries without a YAML dependency. Deliberately textual: this
 * runs before anything is installed on a deploy host, so it must not need
 * `js-yaml`. It reads `- source:target[:opts]` lines under a `volumes:` key.
 */
export function bindMounts(composeText) {
    const out = [];
    let inVolumes = false;
    let volumesIndent = -1;
    for (const raw of composeText.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '');
        if (/^\s*volumes:\s*$/.test(line)) {
            inVolumes = true;
            volumesIndent = line.search(/\S/);
            continue;
        }
        if (!inVolumes) continue;
        const indent = line.search(/\S/);
        if (line.trim() === '') continue;
        // A key at or left of `volumes:` ends the block.
        if (indent <= volumesIndent && !/^\s*-\s/.test(line)) { inVolumes = false; continue; }
        const m = /^\s*-\s*["']?([^"':]+):([^"':]+)(?::([^"']*))?["']?\s*$/.exec(line);
        if (m) out.push({ source: m[1].trim(), target: m[2].trim(), options: (m[3] ?? '').trim() });
    }
    return out;
}

export function checkMounts(composeText, baseDir) {
    const problems = [];
    const skipped = [];
    const checked = [];
    for (const m of bindMounts(composeText)) {
        if (!isCheckableSource(m.source)) { skipped.push(m.source); continue; }
        const abs = path.resolve(baseDir, m.source);
        if (!fs.existsSync(abs)) {
            problems.push(
                `MISSING bind-mount source: ${m.source} (-> ${m.target})\n` +
                `    Docker would create an EMPTY DIRECTORY here and start anyway.\n` +
                `    Put the file at ${abs} before bringing the stack up.`,
            );
            continue;
        }
        const looksLikeFile = /\.[A-Za-z0-9]+$/.test(path.basename(m.source));
        const st = fs.statSync(abs);
        if (looksLikeFile && st.isDirectory()) {
            problems.push(
                `DIRECTORY where a file belongs: ${m.source} (-> ${m.target})\n` +
                `    ${abs} is a directory. This is what a previous \`up\` with a\n` +
                `    missing source leaves behind; replace it with the real file.`,
            );
            continue;
        }
        checked.push(m.source);
    }
    return { problems, skipped, checked };
}

function main(argv) {
    const args = argv.slice(2);
    let base = null;
    const files = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--base') { base = args[i + 1]; i += 1; continue; }
        files.push(args[i]);
    }
    if (files.length === 0) {
        console.error('usage: preflight-compose-mounts.mjs <compose-file> [more…]');
        return 2;
    }
    let failed = false;
    for (const f of files) {
        const abs = path.resolve(REPO_ROOT, f);
        if (!fs.existsSync(abs)) { console.error(`compose file not found: ${f}`); failed = true; continue; }
        const resolveFrom = base === null ? path.dirname(abs) : path.resolve(base);
        const { problems, skipped, checked } = checkMounts(fs.readFileSync(abs, 'utf-8'), resolveFrom);
        // The total is printed beside the parts so the line states its own
        // denominator: "0 checked" alone reads as "nothing to look at" when it
        // can equally mean "everything found was a problem".
        const total = checked.length + skipped.length + problems.length;
        console.log(
            `${f}: ${total} bind mount(s) — ${checked.length} ok, ` +
            `${problems.length} problem(s), ${skipped.length} skipped ` +
            `(named volumes / absolute / interpolated)`,
        );
        for (const p of problems) { console.error(`  ✗ ${p}`); failed = true; }
    }
    if (failed) {
        console.error('\npreflight FAILED — the stack would start with a directory where a file belongs.');
        return 1;
    }
    console.log('preflight passed: every checkable bind-mount source exists and is the right kind.');
    return 0;
}

// Only run when invoked directly, so the guard can import the pure functions.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv));
}
