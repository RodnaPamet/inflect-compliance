/**
 * THE END-TO-END SEAM for the `anthropic-workspace` provider, and the only one.
 *
 * Playwright drives the real card, the real routes and the real provider, and
 * the provider must dial SOMETHING. It cannot dial Anthropic (no key, no
 * network, and a Test against a real workspace would be a test of Anthropic),
 * and `safeFetch` rightly refuses the loopback faux the suite starts. So in an
 * end-to-end run, and only there, the provider sends to this fixed loopback
 * address instead.
 *
 * ── WHY PRODUCTION CANNOT REACH IT ──────────────────────────────────────────
 *
 *   - It is decided by the DEPLOYMENT, never by a tenant. Nothing a tenant
 *     writes is read here: the host rule (`apiHost` is `vendorOrigin` over
 *     `api.anthropic.com` alone) runs first and unchanged on every path, so a
 *     configuration naming another host is still refused in an end-to-end run.
 *   - It needs BOTH `NEXT_TEST_MODE=1` and `AUTH_TEST_MODE=1`. The first is set
 *     only by the Playwright webServer command (and `scripts/e2e-local.mjs`);
 *     the second is refused at startup in production unless the first is set
 *     (`src/instrumentation.ts`). A production process carrying both already
 *     has a credential-login bypass, which is the louder fault.
 *   - The address is a CONSTANT on loopback. There is no variable to point it
 *     anywhere else, so even a deployment that set both flags could send the
 *     key only to its own 127.0.0.1.
 *
 * This module imports nothing, so `playwright.config.ts` can read the port
 * from it and the faux and the provider cannot disagree about it.
 */

/** The loopback port `scripts/e2e-anthropic-workspace-faux.mjs` listens on. */
export const ANTHROPIC_WORKSPACE_E2E_FAUX_PORT = 3008;

/**
 * The origin to dial instead of `https://api.anthropic.com`, or null — which is
 * the answer everywhere except a Playwright run.
 */
export function anthropicWorkspaceE2eOrigin(flags: {
    nextTestMode: string | undefined;
    authTestMode: string | undefined;
}): string | null {
    if (flags.nextTestMode !== '1' || flags.authTestMode !== '1') return null;
    return `http://127.0.0.1:${ANTHROPIC_WORKSPACE_E2E_FAUX_PORT}`;
}

/**
 * `NEXT_TEST_MODE` as the process has it NOW. Read raw, not through `@/env`:
 * the variable is not in the env schema, and the rate limiters read it the same
 * way (`apiReadRateLimit.ts`, `rate-limit-middleware.ts`). This is the one raw
 * read the provider depends on, kept in the seam module so the provider itself
 * holds none, and listed in `tests/unit/no-fallbacks.test.ts` for that reason.
 */
export function nextTestModeFlag(): string | undefined {
    return process.env.NEXT_TEST_MODE;
}
