/**
 * THE DEPLOYMENT-LEVEL PRIVATE-ADDRESS ALLOWLIST (#3328).
 *
 * `safeFetch` refuses every private, loopback, link-local and metadata
 * address, which is right for hosted Inflect and means that today **no MCP
 * server can be on an internal network** — not a customer's legacy-app
 * server and not one of ours. `docs/legacy-access-recertification-design.md`
 * specified the other half and it was never built:
 *
 *   > Self-hosted Inflect may reach private addresses through a
 *   > deployment-level CIDR allowlist declared in `env.ts`. It is never
 *   > tenant-configurable, and the metadata and loopback ranges stay refused
 *   > inside it.
 *
 * This is that. Three properties carry the safety argument, and each is
 * asserted in `tests/guards/egress-allowlist.test.ts`:
 *
 * ═══ 1. NOT TENANT-CONFIGURABLE, STRUCTURALLY ═══
 *
 * The ranges come from one environment variable read at module load. There is
 * no tenant column, no admin form and no API that reaches this. The SSRF
 * threat `allowed-host.ts` names — "would hand any `admin.manage` holder a
 * fetch primitive aimed at an arbitrary https host" — is about a URL an
 * attacker can CHOOSE, and nothing here is chooseable: widening the
 * allowlist is a deployment change by whoever operates the install.
 *
 * ═══ 2. SELF-HOSTED ONLY ═══
 *
 * Gated on `getBillingMode() === 'SELFHOSTED'`. On hosted Inflect the
 * variable is inert even if set, because there the "internal network" is
 * OUR network and a tenant-adjacent fetch into it is the original threat.
 * The gate is read through the shared `billing-mode` module rather than
 * re-deriving `STRIPE_SECRET_KEY`, so there is one definition of which
 * deployment this is.
 *
 * ═══ 3. METADATA AND LOOPBACK STAY REFUSED INSIDE IT ═══
 *
 * `NEVER_ALLOWLISTABLE` is checked BEFORE the allowlist and cannot be
 * overridden by it. An operator who writes `0.0.0.0/0` gets every private
 * range they asked for and still cannot reach `169.254.169.254` or
 * `127.0.0.1`. That ordering is the difference between a capability and a
 * foot-gun: cloud metadata is credential disclosure, and loopback is this
 * process's own admin surfaces, neither of which an MCP server is ever on.
 *
 * Deliberately NOT relaxed: the scheme stays https-only, redirects stay
 * refused, DNS is still re-resolved at use time and EVERY resolved address
 * is checked — a name that resolves outside the allowlist is refused however
 * public it looks. The allowlist widens WHICH addresses are acceptable; it
 * removes no other check.
 */
import { getBillingMode } from '@/lib/billing/billing-mode';
import { logger } from '@/lib/observability/logger';
import { inCidr, isV4Mapped, parseAddress, parseCidr, type Cidr } from './cidr';

/**
 * Ranges the allowlist can never admit, whatever it says.
 *
 * Checked BEFORE the allowlist, so `0.0.0.0/0` in the env still cannot reach
 * any of these. Each is here because an MCP server is never on it and the
 * consequence of reaching it is specific:
 *
 *   127/8, ::1   — this process's own surfaces (admin ports, the DB proxy)
 *   0/8, ::      — "this host", a well-known alias for loopback
 *   169.254/16   — cloud metadata: 169.254.169.254 is credential disclosure
 *   fe80::/10    — v6 link-local, the same reachability as 169.254
 */
const NEVER_ALLOWLISTABLE: readonly Cidr[] = [
    '127.0.0.0/8',
    '0.0.0.0/8',
    '169.254.0.0/16',
    '::1/128',
    '::/128',
    'fe80::/10',
].map((c) => {
    const parsed = parseCidr(c);
    // A literal in this list that does not parse would silently shrink the
    // never-allowlistable set, which is the one direction that must not fail
    // quietly. So it throws at module load instead.
    if (parsed === null) throw new Error(`egress-allowlist: bad built-in CIDR ${c}`);
    return parsed;
});

/** True when no allowlist may admit this address. */
export function isNeverAllowlistable(address: string): boolean {
    const addr = parseAddress(address);
    if (addr === null) return false;
    // A v4-mapped v6 is the same destination written differently, so it is
    // checked as the v4 it maps to as well. Omitting this would let
    // `::ffff:169.254.169.254` through a check that refuses the v4 form.
    if (addr.length === 16 && isV4Mapped(addr)) {
        const v4 = new Uint8Array(addr.slice(12));
        if (NEVER_ALLOWLISTABLE.some((c) => inCidr(v4, c))) return true;
    }
    return NEVER_ALLOWLISTABLE.some((c) => inCidr(addr, c));
}

/**
 * The configured ranges, parsed once.
 *
 * Unparseable entries are DROPPED and named on stderr rather than throwing:
 * the alternative is a deployment that will not boot because of a typo in an
 * optional egress setting, and a dropped entry fails CLOSED — the address it
 * would have admitted stays refused. `env.ts` validates the variable's shape
 * at startup, so this path is the belt to that braces.
 */
let cached: readonly Cidr[] | null = null;
function allowlist(): readonly Cidr[] {
    if (cached !== null) return cached;
    const raw = process.env.EGRESS_PRIVATE_CIDR_ALLOWLIST ?? '';
    const out: Cidr[] = [];
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
        const parsed = parseCidr(entry);
        if (parsed === null) {
            logger.warn('egress allowlist: ignoring unparseable CIDR', {
                component: 'egress-allowlist',
                entry,
                detail: 'addresses it would have admitted stay refused',
            });
            continue;
        }
        out.push(parsed);
    }
    cached = out;
    return cached;
}

/** Test seam. Not exported from any barrel; `env.ts` owns the real value. */
export function resetEgressAllowlistCacheForTests(): void {
    cached = null;
}

/**
 * May this deployment reach `address`, even though it is private?
 *
 * `false` unless ALL of: self-hosted, the address parses, it is not in
 * `NEVER_ALLOWLISTABLE`, and it falls inside a configured range. Every
 * failure mode of this function — unset variable, unparseable entry, wrong
 * deployment mode, unparseable address — returns `false`, which is the
 * refusal the caller would have made anyway.
 */
export function privateEgressAllowed(address: string): boolean {
    if (getBillingMode() !== 'SELFHOSTED') return false;
    const ranges = allowlist();
    if (ranges.length === 0) return false;
    if (isNeverAllowlistable(address)) return false;
    const addr = parseAddress(address);
    if (addr === null) return false;
    if (addr.length === 16 && isV4Mapped(addr)) {
        const v4 = new Uint8Array(addr.slice(12));
        if (ranges.some((c) => inCidr(v4, c))) return true;
    }
    return ranges.some((c) => inCidr(addr, c));
}

/** True when an allowlist is configured AND this deployment may use it. */
export function egressAllowlistActive(): boolean {
    return getBillingMode() === 'SELFHOSTED' && allowlist().length > 0;
}
