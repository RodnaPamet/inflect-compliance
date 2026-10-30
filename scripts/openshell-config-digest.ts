/**
 * Record a digest of the gateway configuration this deploy applies — 5.6e (#4000).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PROVENANCE INSTEAD OF STATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Effective gateway configuration is unobservable from outside the process —
 * 0.1a established there is no config read API, and `declarations.ts` records
 * that `healthz`, `readyz`, `config`, `configz`, `version` and `/api/v1/config`
 * answer 404 to everything but the first two. So the admin page cannot say
 *
 *     Telemetry: off
 *
 * and must instead say something true:
 *
 *     declared, digest sha256:… , applied 2026-10-30T… — gateway reachable,
 *     reporting version 0.1.6
 *
 * This is where that digest comes from: the bytes the deploy is about to apply,
 * hashed before they are applied.
 *
 *   npm run openshell:digest -- --check     # CI: committed digest matches the config
 *   npm run openshell:digest -- --write     # re-record after editing the config
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE DIGEST IS COMMITTED AND NOT ONLY COMPUTED AT DEPLOY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A digest computed only at deploy time is unfalsifiable: whatever was applied
 * hashes to whatever it hashes to, and nothing can disagree. Committing it
 * gives the value something to be WRONG against — editing `gateway.toml`
 * without re-recording fails `--check` in CI, which is what makes the number on
 * the admin page a claim rather than a decoration.
 *
 * It also gives 5.2 (#3972) a second anchor. That phase detects drift by
 * comparing a policy hash and "today has nothing to hash"; a committed config
 * digest is a thing to compare, and a digest that changes without a deploy is
 * drift by definition.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PREFLIGHT, WHERE THE BINARY EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `openshell-gateway config preflight` validates a configuration and exits 0
 * WITHOUT starting the service, so a digest can be validated before it is ever
 * applied. Run when the binary is present and SKIPPED WITH A MESSAGE when it is
 * not — CI has no gateway binary, and a silent skip would let `--check` pass
 * while reporting nothing. Measured behaviour, both arms:
 *
 *     valid config                    exit 0, silent
 *     compute_driver = "not-a-driver" exit 1, category=malformed
 *     malformed TOML                  exit 1
 *     allow_unauthenticated_users=true exit 0   <-- NOT caught
 *
 * That last arm is why preflight does not replace
 * `sandbox-runtime-channels-match-the-runtime`'s assertion: preflight validates
 * the shape of a configuration, not whether its choices are ones we permit.
 *
 * @module scripts/openshell-config-digest
 */

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CONFIG_PATH = 'deploy/openshell/gateway.toml';
export const DIGEST_PATH = 'deploy/openshell/config-digest.txt';

/** `sha256:` over the configuration bytes, exactly as committed. */
export function digestOf(bytes: Buffer): string {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** The digest recorded in the committed file, or null if there is none. */
export function recordedDigest(text: string): string | null {
    const m = /^(sha256:[0-9a-f]{64})\b/m.exec(text);
    return m === null ? null : m[1];
}

function preflight(configPath: string): 'passed' | 'failed' | 'skipped' {
    const bin =
        process.env.OPENSHELL_GATEWAY ??
        path.join(os.homedir(), 'openshell', 'v0.1.6', 'openshell-gateway');
    if (!fs.existsSync(bin)) return 'skipped';
    try {
        execFileSync(bin, ['config', 'preflight', '--path', configPath], { stdio: 'pipe' });
        return 'passed';
    } catch {
        return 'failed';
    }
}

function main(): void {
    const mode = process.argv.includes('--write') ? 'write' : 'check';
    const bytes = fs.readFileSync(CONFIG_PATH);
    const actual = digestOf(bytes);

    const pf = preflight(CONFIG_PATH);
    if (pf === 'failed') {
        console.error(`openshell:digest — ${CONFIG_PATH} FAILED config preflight.`);
        console.error('Refusing to record a digest for a configuration the gateway rejects.');
        process.exit(1);
    }
    console.log(
        pf === 'skipped'
            ? 'openshell:digest — preflight SKIPPED (no gateway binary on this host)'
            : 'openshell:digest — preflight passed',
    );

    if (mode === 'write') {
        const now = new Date().toISOString();
        fs.writeFileSync(
            DIGEST_PATH,
            `${actual}  ${path.basename(CONFIG_PATH)}\n`
                + `# Recorded by \`npm run openshell:digest -- --write\` at ${now}.\n`
                + '# The deploy exports this as SANDBOX_RUNTIME_CONFIG_DIGEST and stamps\n'
                + '# SANDBOX_RUNTIME_APPLIED_AT at apply time. Editing gateway.toml without\n'
                + '# re-running this fails `--check`, which is what makes the digest a claim.\n',
        );
        console.log(`openshell:digest — recorded ${actual}`);
        return;
    }

    const recorded = recordedDigest(fs.readFileSync(DIGEST_PATH, 'utf8'));
    if (recorded === actual) {
        console.log(`openshell:digest — committed digest matches ${CONFIG_PATH}`);
        return;
    }
    console.error('openshell:digest — the committed digest does NOT match the config.');
    console.error(`  config   ${actual}`);
    console.error(`  recorded ${recorded ?? '(none)'}`);
    console.error('Re-record it: npm run openshell:digest -- --write');
    process.exit(1);
}

if (process.argv[1] && process.argv[1].includes('openshell-config-digest')) main();
