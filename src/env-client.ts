// Side effect — set Zod's `jitless` flag (browser only) BEFORE this module's
// own client env-validation parse, which would otherwise be the first thing to
// trigger Zod's CSP-violating `new Function` probe. `src/app/providers.tsx`
// imports it at the client entry too, but import ORDER across modules is not a
// property this file should depend on: the parse below happens at module
// evaluation, so the flag has to be set here as well. See
// src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * THE CLIENT-SIDE ENVIRONMENT, AND THE ONLY ENV MODULE A `'use client'` FILE
 * MAY IMPORT — #4764.
 *
 * `src/env.ts` declares ~90 server variables. A server variable's VALUE never
 * reaches a browser (t3-env throws on a server key read from the client), but
 * its SCHEMA does: the key names, the `z.string()…` calls and the whole
 * `runtimeEnv` mapping are ordinary module code, so anything `next build`
 * bundles for the client carries all of it.
 *
 * Measured on #4759, whose only client-reachable change was four optional
 * server strings added to `src/env.ts`:
 *
 *     124 of 183 routes   +0.1 KB First Load JS
 *      59 of 183 routes    unchanged
 *
 * Four strings taxed two thirds of the app and failed the per-route bundle
 * budget on `controls/[controlId]/tests/[planId]`, a page that has nothing to
 * do with them. The cause was one import edge: `notifications-bell.tsx` is a
 * `'use client'` component, the top chrome mounts it on every workspace page,
 * and it imported `@/env` for a single feature flag — so the server schema was
 * in the client graph for all 183 routes.
 *
 * That edge is now this module, and
 * `tests/guards/client-reachable-modules-import-no-server-env.test.ts` walks
 * the import graph from every `'use client'` file to keep it that way. The
 * guard has no allowlist: a client-reachable module that needs a variable adds
 * it HERE, prefixed `NEXT_PUBLIC_`, which is the only kind of variable it may
 * read anyway.
 *
 * Every variable here is also triaged by
 * `tests/guardrails/sub-processor-coverage.test.ts`, which parses the
 * `runtimeEnv` blocks of this file AND `src/env.ts` — so a client variable
 * cannot escape the sub-processor inventory by living in the smaller file.
 */
export const envClient = createEnv({
    /**
     * Client-side variables. To expose one to the browser it MUST be prefixed
     * `NEXT_PUBLIC_` — t3-env enforces the prefix, and Next inlines the value
     * at build time.
     */
    client: {
        // PR-C 2026-05-27 — opt-in flag for the SSE notification
        // bell. Off by default (the bell stays on REST polling)
        // until the client integration is verified end-to-end in
        // a real browser. Server-side stream is wired regardless;
        // flipping this to '1' is the only step to engage SSE.
        NEXT_PUBLIC_NOTIFICATIONS_SSE: z.enum(['0', '1']).optional(),
    },

    /**
     * You can't destructure `process.env` as a regular object in the Next.js
     * edge runtimes or client-side, so destructure manually.
     */
    runtimeEnv: {
        NEXT_PUBLIC_NOTIFICATIONS_SSE: process.env.NEXT_PUBLIC_NOTIFICATIONS_SSE,
    },
    /**
     * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
     * This is especially useful for Docker builds.
     */
    skipValidation: !!process.env.SKIP_ENV_VALIDATION,
    /**
     * Makes it so that empty strings are treated as undefined.
     * `SOME_VAR: z.string()` and `SOME_VAR=''` will throw an error.
     */
    emptyStringAsUndefined: true,
});

/**
 * `env` is the name every call site already uses, and the two wiring guards
 * match on `env.NEXT_PUBLIC_…`. Exported under both names so a client file
 * reads `import { env } from '@/env-client'` and server code that wants to be
 * explicit can say `envClient`.
 */
export const env = envClient;
