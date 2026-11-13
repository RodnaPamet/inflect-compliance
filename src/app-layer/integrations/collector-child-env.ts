/**
 * THE ENVIRONMENT A POSTURE COLLECTOR'S CHILD PROCESS IS ALLOWED TO SEE (#5253).
 *
 * All three posture providers (aws, azure, gcp) shell out to a CLI — `aws`,
 * `powerpipe`, `steampipe`, `gcloud` — and all three used to build that child's
 * environment as `{ ...process.env }` plus their own credential variables. That
 * is wrong twice over, and the second way is the one that produces false
 * evidence rather than merely leaking.
 *
 * ── 1. EVERY WORKER SECRET REACHED A THIRD-PARTY BINARY ──────────────────────
 *
 * The worker's environment holds `DATA_ENCRYPTION_KEY` (the master KEK that
 * unwraps every tenant's DEK), `DATABASE_URL` and `DIRECT_DATABASE_URL` with
 * their passwords, the Redis password, `NEXTAUTH_SECRET`, and whatever else is
 * configured. None of it is any business of a benchmark runner, and a CLI that
 * logs its environment on a crash — or a compromised build of one — carries all
 * of it off the host. The credential scrubber in the provider redacts the values
 * it KNOWS (`secretValues`), which is the connection's own secrets; it has never
 * known about these.
 *
 * ── 2. AMBIENT CLOUD CREDENTIALS WERE INHERITED, SO THE SCAN COULD RUN AS US ──
 *
 * This is the sharp end. If the host has an AWS instance profile, or any
 * `AWS_*` / `AZURE_*` / `GOOGLE_APPLICATION_CREDENTIALS` / `CLOUDSDK_*` in the
 * worker environment, the inherited copy reaches the child. The provider then
 * sets the tenant's credentials ON TOP — but only the ones the tenant supplied.
 * A connection saved with a role ARN and no key pair (the form
 * `docs/aws-posture-connector.md` called "preferred", and which nothing ever
 * assumed) left no AWS key in the env at all, so the child authenticated with
 * the AMBIENT identity and the benchmark scanned the PLATFORM's own cloud
 * account. That result was then stored as the tenant's posture evidence: an
 * auditable record attributing our account's configuration to a customer.
 *
 * The fix for both is the same, and it is this allowlist. A child starts from
 * nothing and receives only what a CLI genuinely needs to run, plus the
 * credential variables its provider sets explicitly. An ambient credential is
 * not on the list, so it cannot be inherited, so the failure mode above is
 * unrepresentable rather than merely unlikely — and a credential-less connection
 * now fails to authenticate, which is the honest outcome.
 *
 * ── WHAT IS ON THE LIST, AND WHY EACH ONE ────────────────────────────────────
 *
 * Deliberately short. Each entry is here because a collector breaks without it:
 *
 *   • `PATH`   — how `execFile` finds `aws` / `powerpipe` / `steampipe` at all.
 *   • `HOME`   — steampipe and powerpipe keep their installed mods, plugin
 *                binaries and connection state under `~/.steampipe` and
 *                `~/.powerpipe`. Without it they re-initialise, or fail.
 *   • `TMPDIR` — the GCP provider writes its service-account key to a 0600 file
 *                under `tmpdir()` and hands the child the path; the CLIs also
 *                use temp space for their own work.
 *   • `LANG`, `LC_ALL` — locale. Not load-bearing, but their absence makes some
 *                CLI builds emit encoding warnings onto stderr, which this
 *                subsystem captures, scrubs and persists as a run's error text.
 *
 * NOTHING ELSE. In particular no `NODE_*`, no proxy variables (a collector that
 * must egress through a proxy is a deliberate change, not an inheritance), and
 * above all no cloud credential of any kind.
 *
 * Adding an entry is a security decision: say which collector breaks without it,
 * and satisfy yourself it cannot carry a credential.
 * `tests/guards/posture-collector-child-env.test.ts` fails if a provider goes
 * back to spreading `process.env`, and holds this list by exact equality.
 */

/** The only variables inherited from the parent, by name. */
export const COLLECTOR_ENV_ALLOWLIST: readonly string[] = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
];

/**
 * A minimal environment for a collector child, carrying only the allowlisted
 * variables that are actually set in this process.
 *
 * An unset or empty variable is OMITTED rather than passed as `''`: an empty
 * `HOME` is worse than no `HOME` for the CLIs that read it, because it resolves
 * paths against the filesystem root instead of falling back.
 *
 * Callers add their own credential variables to the returned object. It is a
 * fresh object every call, so a caller mutating it cannot affect `process.env`
 * or another call — the property the AWS provider's "does not mutate
 * process.env" test already asserted and which must survive this change.
 */
export function baseCollectorEnv(): NodeJS.ProcessEnv {
    // NODE_ENV first and unconditionally, and it is NOT in the allowlist above.
    // `NodeJS.ProcessEnv` — the type `execFile`'s `env` option takes — declares
    // it REQUIRED and readonly (`next/types/global.d.ts`), so an object without
    // it does not typecheck. It is not a credential and no collector reads it:
    // it is here to satisfy that type, which is exactly why it is kept out of
    // COLLECTOR_ENV_ALLOWLIST — that list is the security-reviewed one, and the
    // guard holds it by exact equality.
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
    for (const key of COLLECTOR_ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value) env[key] = value;
    }
    return env;
}
