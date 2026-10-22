/**
 * THE #3867 VERIFY, AS A COMMAND (#3867).
 *
 * Drives Inflect's REAL egress path against the stub: the save-time structural
 * check, the use-time check that re-resolves DNS and re-validates every
 * address, then the actual MCP tool client — which reaches the network through
 * `safeFetch` and nothing else. No mock, no `fetchImpl`, no test seam.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT RUNS BOTH CONFIGURATIONS, SO THE CONTROL CANNOT BE SKIPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A passing egress check is worth nothing on its own: it is indistinguishable
 * from a check that never ran. The discriminator is the same call with the
 * allowlist UNSET, which must be refused by name.
 *
 * `EGRESS_PRIVATE_CIDR_ALLOWLIST` is read once and cached in
 * `egress-allowlist.ts`, so one process can only hold one configuration. This
 * therefore re-executes ITSELF as two children — CONTROL then LIVE — and prints
 * both rows. Running it is the whole evidence; there is no second command a
 * person has to remember, and no way to publish the pass without the refusal
 * beside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT FAILS IN BOTH DIRECTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exit 1 if the LIVE run cannot reach the stub — the obvious direction. Also
 * exit 1 if the CONTROL run SUCCEEDS, because that means the guard admitted a
 * private address with no allowlist, which is a far more serious finding than a
 * stub being unreachable. A verification that can only fail one way is half a
 * verification.
 *
 * Usage, with the stub already running (`PORT=8444 ./run-stub.sh`):
 *
 *     SKIP_ENV_VALIDATION=1 \
 *     NODE_EXTRA_CA_CERTS=$PWD/.certs/stub-cert.pem \
 *       npx tsx verify-egress.ts [--url https://host:port/mcp] [--cidr 192.168.56.0/24]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertPublicAddress, checkWebhookUrl } from '@/app-layer/automation/webhook-safety';
import { callTool, listTools } from '@/app-layer/integrations/mcp/client';

const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const URL_ = arg('url', 'https://192.168.56.1:8444/mcp');
const CIDR = arg('cidr', '192.168.56.0/24');
/** Set by the parent on each child, so a child knows which row it is. */
const ROLE = process.env.VERIFY_EGRESS_ROLE;

/**
 * Child exit codes, and why there are THREE of them.
 *
 * `0` reached, `2` refused-as-expected, anything else BROKEN. The first version
 * returned a boolean, which made a child that CRASHED indistinguishable from one
 * the guard refused — so a script with a typo in it would have printed PASS,
 * reporting that the egress guard refused a private address when in truth
 * nothing had been asked. That is the same inexpressive-control failure this
 * tool exists to rule out, one level up, and it was in the tool.
 */
const REACHED = 0;
const REFUSED = 2;

/** One configuration, end to end. Returns true when the stub was reached. */
async function attempt(): Promise<boolean> {
    const mode = process.env.STRIPE_SECRET_KEY ? 'SAAS' : 'SELFHOSTED';
    const allow = process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST ?? '(unset)';
    console.log(`    billingMode=${mode}  allowlist=${allow}`);

    const verdict = checkWebhookUrl(URL_);
    console.log(`    checkWebhookUrl      -> ok=${verdict.ok}${verdict.reason ? `  reason=${verdict.reason}` : ''}`);
    if (!verdict.ok) return false;

    try {
        const res = await assertPublicAddress(URL_);
        console.log(`    assertPublicAddress  -> ${res.addresses.map((a) => a.address).join(', ')}`);
    } catch (e) {
        console.log(`    assertPublicAddress  -> REFUSED  ${(e as Error).message}`);
        return false;
    }

    // NO `authorization`, deliberately. The stub does not authenticate, and
    // `McpClientOptions.authorization` is documented as "the caller resolves it
    // from the connection's secrets" — so passing a placeholder here would imply
    // this exercises the credential path, which it does not. That seam, from a
    // stored `secretEncrypted` through `resolveMcpCredentials` to this header,
    // is the part of the VERIFY this command cannot reach.
    const tools = await listTools({ url: URL_ });
    console.log(`    listTools            -> ${tools.map((t) => t.name).join(', ')}`);
    if (tools.length === 0) return false;

    const out = await callTool({ url: URL_ }, 'sales_orders_by_creator', {
        sap_username: 'MMUELLER',
        sold_to_party: '0000100201',
        date_from: '2026-06-17',
        date_to: '2026-06-17',
    });
    const payload = JSON.parse(out.content[0]?.text ?? '{}') as {
        count?: number;
        orders?: { currency: string }[];
    };
    const currencies = [...new Set((payload.orders ?? []).map((o) => o.currency))].join('/');
    console.log(`    callTool             -> ${payload.count ?? 0} orders, currencies ${currencies || '(none)'}`);
    // More than one currency is the fixture that proves no total can be summed.
    return (payload.count ?? 0) > 0;
}

/** Re-execute self with one configuration, and report whether it reached. */
type Outcome = 'reached' | 'refused' | 'broken';

function child(role: 'CONTROL' | 'LIVE', env: Record<string, string | undefined>): Outcome {
    // Through `npx tsx`, from the REPO ROOT. Spawning `process.execPath`
    // directly gets plain node with no TypeScript and no `@/` path mapping, and
    // the resulting ERR_MODULE_NOT_FOUND looked exactly like a refusal.
    const self = fileURLToPath(import.meta.url);
    const root = path.resolve(path.dirname(self), '..', '..');
    const r = spawnSync('npx', ['tsx', self, ...process.argv.slice(2)], {
        cwd: root,
        env: { ...process.env, VERIFY_EGRESS_ROLE: role, ...env },
        stdio: 'inherit',
    });
    if (r.status === REACHED) return 'reached';
    if (r.status === REFUSED) return 'refused';
    return 'broken';
}

async function main(): Promise<void> {
    if (ROLE !== undefined) {
        // An exception leaves the default non-zero, non-REFUSED code, so the
        // parent reads it as broken rather than as a refusal.
        process.exit((await attempt()) ? REACHED : REFUSED);
    }

    console.log(`\n  VERIFY — Inflect's real egress path against ${URL_}\n`);

    // The CONTROL first, deliberately: if the guard is not refusing, the LIVE
    // row below means nothing and should not be read as reassurance.
    console.log('  CONTROL — allowlist unset. This MUST be refused.');
    const control = child('CONTROL', { EGRESS_PRIVATE_CIDR_ALLOWLIST: undefined });

    console.log(`\n  LIVE — allowlist ${CIDR}, SELFHOSTED. This must reach the stub.`);
    const live = child('LIVE', { EGRESS_PRIVATE_CIDR_ALLOWLIST: CIDR });

    console.log('');
    if (control === 'broken' || live === 'broken') {
        console.log('  FAIL — a run did not complete, so neither row is evidence.');
        console.log(`         control=${control}  live=${live}`);
        console.log('         Fix the error above before reading anything into the result.');
        process.exit(1);
    }
    if (control === 'reached') {
        console.log('  FAIL — the CONTROL reached the stub with NO allowlist set.');
        console.log('         The egress guard admitted a private address it should refuse.');
        console.log('         That is a finding about the guard, not about the stub.');
        process.exit(1);
    }
    if (live !== 'reached') {
        console.log('  FAIL — the guard refuses as it should, but the LIVE run could not reach');
        console.log('         the stub. Check it is running, that NODE_EXTRA_CA_CERTS points at');
        console.log('         its certificate, and that --cidr covers the host.');
        process.exit(1);
    }
    console.log('  PASS — refused without the allowlist, reached with it.');
    console.log('         Egress and transport verified. NOT covered: the credential seam —');
    console.log('         a stored secretEncrypted resolved through resolveMcpCredentials into');
    console.log('         the Authorization header — nor the connection row and admin UI.');
}

void main();
