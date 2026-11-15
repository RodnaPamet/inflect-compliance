/**
 * GAP-10 — Builder for the OpenAPI 3.1 document.
 *
 * Two callers:
 *   1. `scripts/generate-openapi.ts` — CLI that writes the result
 *      to `public/openapi.json`.
 *   2. `tests/contracts/api-schemas.test.ts` — contract test that
 *      compares the result against the committed file (drift
 *      detection) and snapshots each component schema individually.
 *
 * Single source of truth: this builder. The CLI and the test must
 * NEVER drift apart — that's why the registry walk + import list
 * lives here, not duplicated.
 *
 * Determinism contract:
 *   - The only dynamic input is `package.json::version`. No
 *     timestamps, no env-dependent paths, no random ids.
 *   - The asteasolutions generator emits keys in registration order,
 *     and the registration loop below is deterministic, so two runs
 *     without code changes produce structurally identical output.
 *   - When the spec is JSON-stringified with a fixed indent, two
 *     runs produce byte-identical output. The contract test relies
 *     on this.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    OpenApiGeneratorV31,
    getRefId as getOpenApiRefId,
    type OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { registry } from '@/lib/openapi/registry';

// Path resolution. We deliberately use `process.cwd()` rather than
// `import.meta.url` or `__dirname` — the file is consumed by both
// Jest (CommonJS, no `import.meta`) and tsx in ESM mode (no
// `__dirname`). `npm run openapi:generate` and `npx jest` are both
// invoked from the repo root, so `process.cwd()` is stable.
//
// If a future caller needs to invoke this from a different CWD, pass
// an explicit `repoRoot` option to `buildOpenApiDoc()` instead of
// reaching for the runtime tricks.

// ─── Force every annotated module to evaluate ───────────────────────
//
// Importing each module triggers its top-level `.openapi(...)` calls
// at module-load time, writing metadata into the schemas'
// `_def.openapi`. The `registerAnnotated` walk below picks them up
// from the module-export iteration.
//
// When a new annotated schema module ships, add its import here.

import * as requestSchemas from '@/lib/schemas';
import * as commonDTOs from '@/lib/dto/common';
import * as controlDTOs from '@/lib/dto/control.dto';
import * as riskDTOs from '@/lib/dto/risk.dto';
import * as evidenceDTOs from '@/lib/dto/evidence.dto';
import * as policyDTOs from '@/lib/dto/policy.dto';
import * as auditDTOs from '@/lib/dto/audit.dto';
import * as assetDTOs from '@/lib/dto/asset.dto';
import * as taskDTOs from '@/lib/dto/task.dto';
import * as vendorDTOs from '@/lib/dto/vendor.dto';
import * as frameworkDTOs from '@/lib/dto/framework.dto';
import * as apiExtraDTOs from '@/lib/dto/api-extra.dto';

// Side-effect import: registers the route-level path operations
// (the critical endpoint set) on the shared registry. Must run before
// `generateDocument()` so `paths` are emitted.
import '@/lib/openapi/paths';

// Filesystem route-walker: emits STUB path entries for every route.ts
// the critical set above doesn't already cover, so the published spec
// is COMPLETE (every endpoint visible) even where the body/response
// contract isn't formally published yet.
import { registerRouteStubs } from './openapi-route-walker';

export const REPO_ROOT = process.cwd();
export const OUTPUT_PATH = resolve(REPO_ROOT, 'public/openapi.json');
export const API_ROOT = resolve(REPO_ROOT, 'src/app/api');

// ─── Helpers ────────────────────────────────────────────────────────

interface ZodLike {
    parse: unknown;
    _def?: unknown;
}

function isAnnotatedZod(value: unknown): value is ZodLike {
    return Boolean(
        value &&
            typeof value === 'object' &&
            typeof (value as { parse?: unknown }).parse === 'function' &&
            typeof (value as { _def?: unknown })._def === 'object',
    );
}

// zod-to-openapi v8 stores `.openapi(name)` metadata in an internal
// WeakMap keyed by the zod schema instance — it is NOT on `_def.openapi`
// any more (v7 layout). Use the package's exported `getRefId` helper
// to read the registered ref id back out.
function getRefId(schema: ZodLike): string | undefined {
    return getOpenApiRefId(schema as never);
}

function registerAnnotated(
    target: OpenAPIRegistry,
    ns: Record<string, unknown>,
): number {
    let count = 0;
    const seen = new Set<unknown>();
    for (const value of Object.values(ns)) {
        if (!isAnnotatedZod(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        const refId = getRefId(value);
        if (!refId) continue;
        const alreadyRegistered = target.definitions.some((d) => {
            const def = d as { schema?: ZodLike };
            return def.schema && getRefId(def.schema) === refId;
        });
        if (alreadyRegistered) continue;
        target.register(refId, value as never);
        count++;
    }
    return count;
}

/**
 * Register a `components.securitySchemes` entry, skipping if a scheme
 * with the same id is already present (the registry singleton survives
 * across in-process rebuilds).
 */
function registerSecuritySchemeOnce(
    target: OpenAPIRegistry,
    name: string,
    scheme: Parameters<OpenAPIRegistry['registerComponent']>[2],
): void {
    const already = target.definitions.some((d) => {
        const def = d as { type?: string; componentType?: string; name?: string };
        return def.type === 'component' && def.componentType === 'securitySchemes' && def.name === name;
    });
    if (already) return;
    target.registerComponent('securitySchemes', name, scheme);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface BuildOptions {
    /**
     * If true, log per-module registration counts to stdout. The CLI
     * sets this; the test does not.
     */
    verbose?: boolean;
}

/**
 * Build the OpenAPI 3.1 document from the annotated schema layer.
 *
 * Idempotent under repeat calls IN-PROCESS only — the registry is a
 * module-level singleton, so the first call registers schemas and the
 * second call observes "already registered" for every schema and
 * still produces the same document. The CLI calls this once; the
 * test calls it once. Tests that call multiple times in a single
 * process see consistent output.
 */
export function buildOpenApiDoc(opts: BuildOptions = {}): {
    openapi: string;
    info: { title: string; version: string; description?: string; license?: { name: string } };
    servers?: Array<{ url: string; description?: string }>;
    components?: { schemas?: Record<string, unknown> };
    paths?: Record<string, unknown>;
} {
    const sources: Array<{ ns: Record<string, unknown>; label: string }> = [
        { ns: requestSchemas, label: '@/lib/schemas' },
        { ns: commonDTOs, label: '@/lib/dto/common' },
        { ns: controlDTOs, label: '@/lib/dto/control.dto' },
        { ns: riskDTOs, label: '@/lib/dto/risk.dto' },
        { ns: evidenceDTOs, label: '@/lib/dto/evidence.dto' },
        { ns: policyDTOs, label: '@/lib/dto/policy.dto' },
        { ns: auditDTOs, label: '@/lib/dto/audit.dto' },
        { ns: assetDTOs, label: '@/lib/dto/asset.dto' },
        { ns: taskDTOs, label: '@/lib/dto/task.dto' },
        { ns: vendorDTOs, label: '@/lib/dto/vendor.dto' },
        { ns: frameworkDTOs, label: '@/lib/dto/framework.dto' },
        { ns: apiExtraDTOs, label: '@/lib/dto/api-extra.dto' },
    ];

    let totalRegistered = 0;
    for (const { ns, label } of sources) {
        const n = registerAnnotated(registry, ns);
        if (opts.verbose) {

            console.log(`[openapi-build] ${label}: registered ${n} schemas`);
        }
        totalRegistered += n;
    }

    // ─── Security schemes ───────────────────────────────────────────
    //
    // Declared to match the ACTUAL auth transports (not invented):
    //   - BearerAuth: tenant API keys flow as `Authorization: Bearer
    //     iflk_…` (src/lib/auth/api-key-auth.ts::extractBearerToken +
    //     isApiKeyToken). THIS is the canonical partner-integration
    //     flow — declared first so it's the Swagger-UI default.
    //   - SessionCookie: browser sessions are a NextAuth JWT cookie. The
    //     NAME depends on the scheme: next-auth v4 prefixes `__Secure-`
    //     when the deployment URL is https
    //     (`node_modules/next-auth/core/lib/cookie.js` —
    //     `useSecureCookies ? '__Secure-' : ''`, defaulted in `init.js` from
    //     `url.base.startsWith('https://')`), and `src/auth.ts` configures
    //     neither `useSecureCookies` nor `cookies`, so that default governs.
    //     This document declares an https production server, so the
    //     production name carries the prefix — it said the bare name until
    //     #5659, which is the name that exists only on http localhost.
    //
    // Registering twice in one process is harmless — the registry
    // singleton de-dupes component IDs, and the CLI/test each build once.
    registerSecuritySchemeOnce(registry, 'BearerAuth', {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key (iflk_…) or JWT',
        description:
            'Tenant API key passed as `Authorization: Bearer iflk_…`. This is the canonical ' +
            'partner-integration flow — mint a key under Admin → API Keys. See docs/api-consumer-guide.md.',
    });
    registerSecuritySchemeOnce(registry, 'SessionCookie', {
        type: 'apiKey',
        in: 'cookie',
        // The https name, matching this document's own production server. On
        // http localhost next-auth drops the prefix and the cookie is
        // `next-auth.session-token` — stated in the description rather than
        // picked, because a scheme carries one name and the deployments an
        // integrator reads this for are https.
        name: '__Secure-next-auth.session-token',
        description:
            'Browser session cookie (NextAuth JWT). Sent automatically for same-origin requests; ' +
            'used by the dev/staging "Try it out" flow. Not the partner flow — prefer a Bearer API key.\n\n' +
            'The name is scheme-dependent: `__Secure-next-auth.session-token` over **https** (every ' +
            'hosted deployment), and `next-auth.session-token` over **http** — next-auth v4 adds the ' +
            '`__Secure-` prefix when the deployment URL is https.',
    });

    // ─── Route stubs ────────────────────────────────────────────────
    //
    // Walk src/app/api/**/route.ts and register a stub for every
    // (method, path) the critical set didn't already cover. Runs AFTER
    // the critical paths import (top of file) so dedup sees them.
    const { stubs, total } = registerRouteStubs(registry, API_ROOT);
    if (opts.verbose) {

        console.log(`[openapi-build] route walker: ${total} operations found, ${stubs} stubs registered`);
    }

    const pkg = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string; name: string };

    const generator = new OpenApiGeneratorV31(registry.definitions);
    const doc = generator.generateDocument({
        openapi: '3.1.0',
        info: {
            title: 'Inflect Compliance API',
            version: pkg.version,
            description:
                'Multi-tenant compliance-management API. The schema layer in `src/lib/schemas/index.ts` ' +
                '(request bodies) and `src/lib/dto/*.dto.ts` (response shapes) is the single source of ' +
                'truth — this document is generated from those Zod schemas via `npm run openapi:generate`.\n\n' +
                '**Authenticating.** To try an endpoint, click **Authorize**:\n' +
                '- *BearerAuth* (recommended for integrations) — paste a tenant **API key** (`iflk_…`), ' +
                'minted under Admin → API Keys. Sent as `Authorization: Bearer iflk_…`.\n' +
                '- *SessionCookie* — for the dev/staging "Try it out" flow, sign in first; the browser ' +
                'sends the NextAuth session cookie automatically (same-origin only). Its name is ' +
                '`__Secure-next-auth.session-token` over https and `next-auth.session-token` over ' +
                'http.\n\n' +
                '**Coverage.** Operations marked `x-stub: true` exist and are callable, but their request/' +
                'response bodies are not yet published in this contract — only the critical-endpoint set ' +
                'carries full schemas. See `docs/api-consumer-guide.md` for the auth, rate-limit, ' +
                'versioning, and error-contract details.',
            license: { name: 'Proprietary' },
        },
        servers: [
            { url: 'https://app.example.com', description: 'Production' },
            { url: 'https://staging.example.com', description: 'Staging' },
            { url: 'http://localhost:3000', description: 'Local development' },
        ],
        security: [{ BearerAuth: [] }, { SessionCookie: [] }],
    });

    if (opts.verbose) {

        console.log(`[openapi-build] Total registered (deduped): ${totalRegistered}`);
    }

    return doc;
}

/**
 * Canonical serialisation. The contract test compares
 * `serializeDoc(buildOpenApiDoc())` against the committed
 * `public/openapi.json` byte-for-byte; the CLI writes
 * `serializeDoc(buildOpenApiDoc())` to disk. The single function
 * guarantees both paths produce identical output.
 *
 * Determinism note: this function sorts `components.schemas` keys
 * alphabetically before serialising. Without the sort, the output
 * order tracks registration order, which in turn tracks
 * `Object.values(<imported module>)` order — and that varies by
 * runtime (Jest's CJS transform vs tsx's ESM loader iterate the
 * same `import * as ns from '…'` differently). Sorting at the
 * serialisation boundary makes the byte output independent of
 * the runtime — which is what the contract test relies on.
 */
export function serializeDoc(doc: ReturnType<typeof buildOpenApiDoc>): string {
    const stable = doc as {
        components?: { schemas?: Record<string, unknown> };
        paths?: Record<string, Record<string, unknown>>;
    };
    if (stable.components?.schemas) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(stable.components.schemas).sort()) {
            sorted[key] = stable.components.schemas[key];
        }
        stable.components.schemas = sorted;
    }
    // Same determinism contract as components.schemas: `paths` are
    // emitted in registerPath() order, which tracks module import
    // order and could differ across runtimes. Sort path keys AND the
    // per-path method keys so the byte output is runtime-independent.
    if (stable.paths) {
        const sortedPaths: Record<string, Record<string, unknown>> = {};
        for (const pathKey of Object.keys(stable.paths).sort()) {
            const ops = stable.paths[pathKey];
            const sortedOps: Record<string, unknown> = {};
            for (const method of Object.keys(ops).sort()) {
                sortedOps[method] = ops[method];
            }
            sortedPaths[pathKey] = sortedOps;
        }
        stable.paths = sortedPaths;
    }
    return JSON.stringify(doc, null, 2) + '\n';
}
