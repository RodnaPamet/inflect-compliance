# Dependency risk review

> Part of the dependency-governance model — see
> `docs/dependency-governance.md` for the four-pillar overview and
> the contributor lifecycle. This document is the **runtime-risk**
> layer.

A periodic, package-by-package security + classification review of
dependencies with a history of CVE activity or a large blast radius.
This is a *posture document* — a reusable template for future audits,
not a one-off note. It complements `docs/dependency-policy.md` (which
covers install-time policy: strict peers, `npm ci`, overrides).

## Why these packages

Each entry below is reviewed because it (a) parses untrusted input,
(b) handles credentials / network egress, or (c) has a documented
history of advisories in its ecosystem. The review answers four
questions per package:

1. **Where is it used?** Every import site in shipping code.
2. **Is it classified correctly?** `dependencies` (ships in the
   production image) vs `devDependencies` (stripped by
   `npm prune --omit=dev` in the `Dockerfile`).
3. **Version + exposure risk.** Pinned vs latest, audit posture,
   maintenance health.
4. **Decision.** Upgrade (in-major only), reclassify (only with
   proof of zero runtime use), isolate, or document-and-justify.

## Reclassification safety rule

Moving a package `dependencies` → `devDependencies` is **dangerous**.
The production `Dockerfile` runs `npm prune --omit=dev`; a
runtime-needed package wrongly in `devDependencies` is stripped from
the image and the app crashes in production — and CI, which installs
*with* devDependencies, will not catch it.

A package may only move to `devDependencies` with an **exhaustive
grep** proving zero import anywhere that ships in the build — all of
`src/**`, `next.config.js`, `src/instrumentation.ts`, dynamic
`import()` and `require()` included. When in any doubt, leave the
classification and document the reasoning. **Never** remove a
package as part of a risk review.

---

## Review — 2026-05-22

Scope: `js-yaml`, `jszip`, `pdfkit`, `nodemailer`. All four are
declared in `dependencies`.

### js-yaml — `^5.0.0`

| | |
|---|---|
| **Direct?** | Yes (also transitive via `eslint`, `semantic-release`, `ts-jest`). |
| **Runtime use** | `src/app-layer/libraries/library-loader.ts` and `src/app-layer/services/mapping-set-importer.ts` — both `yaml.load()` the framework-library + mapping-set YAML files. This is `src/app-layer` code that ships in the production build. Also `prisma/catalog-loader.ts` (seed-time) and six `tests/guards/*` workflow-lint tests. |
| **Classification** | `dependencies` — **correct**. `src/app-layer` is shipped code; the library-import service path is reachable at runtime. |
| **Version** | `5.0.0`. **4→5 reviewed 2026-06-23** (dependabot). Every call site is a bare `yaml.load(content)` with NO options object, so the v5 option removals (`onWarning`, `legacy`, `listener`, `styles`, `replacer`, `noCompatMode`, …) don't touch us. v5 still ships a CommonJS `require` export, so `import * as yaml from 'js-yaml'` + `yaml.load` resolves unchanged under ts-jest. The two behavioural v5 changes that *could* bite — `load('')` now throws (we only load non-empty first-party fixture files) and the default schema moving YAML 1.1 → 1.2 `CORE_SCHEMA` (our YAML uses no 1.1-only constructs) — are both validated by the full test sweep: all library-loader / mapping-set-importer / workflow-lint suites pass against v5. |
| **Exposure** | Parses YAML. v4 dropped the unsafe `yaml.load` default that made v3 dangerous; v5 keeps that safe-by-default `load` (no arbitrary type construction). All call sites parse trusted first-party YAML (framework libraries, mapping sets, our own workflow/helm files in tests) — never request input. The transitive older `js-yaml` under `ts-jest` is dev-only and never touches request input. |
| **Maintenance** | Mature, stable, widely used. No open advisories against v5. |
| **Decision** | **Reviewed — 4→5 major bump accepted (load-only usage is API-compatible; behavioural changes verified safe by the test sweep).** |

### jszip — `^3.10.1`

| | |
|---|---|
| **Direct?** | Yes (sole copy in the tree — no transitive dupes). |
| **Runtime use** | `src/app-layer/jobs/evidence-import.ts` — `JSZip.loadAsync()` on uploaded evidence archives. Registered as the `evidence-import` executor in `src/app-layer/jobs/executor-registry.ts`, so it is a live background-job path. |
| **Classification** | `dependencies` — **correct**. The job runs in the shipped worker. |
| **Version** | `3.10.1` is `latest`. v3 is the current stable line (no v4). |
| **Exposure** | Decompresses untrusted ZIPs — a zip-bomb / path-traversal surface. The code already mitigates: `evidence-import.ts` cross-checks the central directory's declared sizes via jszip and rejects oversized entries, and `tests/integration/evidence-import.test.ts` exercises traversal-form normalisation. The decompression bound is the application's responsibility and is already implemented. |
| **Maintenance** | Slower cadence (last publish 2025-03) but stable and not deprecated. |
| **Decision** | **Reviewed — correctly classified, at latest, no action.** The untrusted-archive risk is real but already bounded in `evidence-import.ts`; that bound is the durable mitigation. |

### pdfkit — `^0.18.0`

| | |
|---|---|
| **Direct?** | Yes. |
| **Runtime use** | `src/lib/pdf/*` (`pdfKitFactory.ts`, `table.ts`, `sections.ts`, `layout.ts`) and the report generators under `src/app-layer/reports/pdf/*`, consumed by the PDF API routes (`src/app/api/t/[tenantSlug]/reports/pdf/generate/route.ts`, access-review export). |
| **Classification** | `dependencies` — **correct**. Listed in `next.config.js` `serverExternalPackages` because it uses `stream`/`zlib`/native deps that don't survive webpack bundling; the report route pins `export const runtime = 'nodejs'`. This is unambiguously shipped runtime code. |
| **Version** | `0.18.0` is `latest`. The `0.x` numbering is the package's long-standing convention — it is a mature project, not pre-release; `^0.18.0` correctly locks to the `0.18` minor. |
| **Exposure** | Generates PDFs from server-side data; does not parse untrusted input. Low input-driven risk. |
| **Maintenance** | Active (last publish 2026-03), not deprecated. |
| **Decision** | **Reviewed — correctly classified, at latest, no action.** |

### nodemailer — `^9.0.1`

| | |
|---|---|
| **Direct?** | Yes (also a peer of `next-auth@4`, pinned to the root version via the `overrides` block — `"nodemailer": "$nodemailer"`). |
| **Runtime use** | `src/lib/mailer.ts` — `NodemailerProvider` wraps `nodemailer.createTransport` for production SMTP; selected by `initMailerFromEnv()` when `SMTP_HOST` is set. Underpins all transactional email. |
| **Classification** | `dependencies` — **correct**. The mailer ships and runs in production. |
| **Version** | `9.0.1`. **8→9 reviewed 2026-06-18** (dependabot production-security group, advisory fix). v9's only breaking change is dropping Node < 18 support — prod runs Node 24. Our usage (`createTransport({host,port,secure,auth})` + `sendMail({to,subject,text,html,bcc,attachments})`) is stable core API, unchanged across the major. Typecheck passes against the existing `@types/nodemailer@^8` (the runtime API surface we touch is type-compatible). |
| **Exposure** | Handles SMTP credentials + outbound network egress. nodemailer has a CVE history (header-injection classes); the 9.x line carries the latest fixes. The code passes only structured fields (`to`, `subject`, `text`/`html`, `bcc`) to `sendMail` — no raw header construction. |
| **Maintenance** | Actively maintained. |
| **Decision** | **Reviewed — 8→9 major bump accepted (security fix, API-compatible for our usage).** |

## Summary

| Package | Classification | Version vs latest | Decision |
|---------|----------------|-------------------|----------|
| `js-yaml` | `dependencies` ✓ | `5.0.0` (4→5 reviewed) | Major bump accepted (load-only, verified by sweep) |
| `jszip` | `dependencies` ✓ | `3.10.1` = latest | No action |
| `pdfkit` | `dependencies` ✓ | `0.18.0` = latest | No action |
| `nodemailer` | `dependencies` ✓ | `9.0.1` (8→9 reviewed) | Major bump accepted (security fix) |

`npm audit --omit=dev --audit-level=moderate` reports **0
vulnerabilities** in production dependencies. No package is
deprecated. All four are at the latest published version inside
their current major and are genuine runtime dependencies — none can
safely move to `devDependencies`, and no in-major upgrade is
available or needed.

This review made **no `package.json` change** — the four packages
were already correctly classified and current. That is a valid,
documented outcome: a risk review's job is to *verify* posture, and
"verified clean" is as legitimate a result as a remediation.

Feature regression coverage was confirmed adequate rather than
re-added: `tests/unit/mailer.test.ts` (nodemailer transport
wiring), `tests/pdf/generators.test.ts` + `tests/pdf/table.test.ts`
(pdfkit), `tests/unit/library-loader.test.ts` +
`tests/unit/mapping-set-importer.test.ts` (js-yaml parsing),
`tests/integration/evidence-import.test.ts` (jszip archive
extraction) — 192 tests, all green.

## Review — 2026-09-20 — the agent runtime

Two packages added by the Flue tools adapter. Both qualify under the
criteria above: `@flue/runtime` **parses untrusted input** (model output and
tool results) and **performs network egress** to model providers;
`valibot` is the schema layer that **validates model-supplied tool
arguments**. Neither could be added without a section here.

### `@flue/runtime` — `2.1.0` (exact)

**1. Where is it used?** Exactly one import site in shipping code, and it is
type-only:

```
src/lib/agentic/flue/tools-adapter.ts:318
    import type { useTool as FlueUseTool } from '@flue/runtime';
```

It feeds `__assertDescriptorIsALegalFlueTool`, a function that is never
called and exists so `tsc` proves the adapter's descriptor is a legal
`useTool` argument. **Nothing from the package enters the bundle today** —
a type-only import is erased at compile time.

**2. Is it classified correctly?** It is in `dependencies`, and that is the
deliberate answer rather than the automatic one. On today's usage alone the
honest classification is `devDependencies`: the only import is erased, so
`npm prune --omit=dev` would strip it with no runtime effect. It is in
`dependencies` because the adapter exists **to be executed** — the moment
`DRIVER_IMPLEMENTED.flue` flips, the package is a runtime dependency, and
the reclassification safety rule above says that direction is the dangerous
one to get wrong. Classifying it as runtime now costs image size;
classifying it as dev now costs a production crash on the day the driver is
enabled, in a code path CI cannot see.

**3. Version + exposure risk.** 118 transitive packages — by some distance
the largest single addition in this review. Apache-2.0, compatible inbound
with the BUSL-1.1 product. Pinned **exactly** at `2.1.0` rather than a
caret, because a runtime that executes agents should not move minor versions
without somebody reading the diff.

The exposure that matters is transitive: `@flue/runtime` pins `hono`
**exactly** at `4.12.32`, which carries four advisories (one fixed in
4.12.34, three in 4.13.5). This repo's pre-existing `overrides` entry
(`hono: ^4.13.5`) resolves it to 4.13.8 and clears all four. That override
had been INERT since 2026-08-03 and was kept specifically so the floor would
re-apply "if hono returns" — this is the change that made it return. See the
notes in `tests/guards/override-registry.json`.

`npm audit --omit=dev` reports the same two pre-existing advisories
(`image-size` via `pptxgenjs`) before and after this addition, and
`scripts/audit-gate.mjs` passes with its two tracked exemptions matched and
in date. **Adding this dependency introduced no new advisory** — measured
both ways, not assumed.

**4. Decision.** Adopt, exact-pinned, in `dependencies`. Revisit the pin on
any upgrade; a minor bump here is a change to the engine that executes
agents and is not a routine caret bump.

### `valibot` — `^1.5.0`

**1. Where is it used?** Two sites, one of them real:

```
src/lib/agentic/flue/json-schema-to-valibot.ts:39   import * as v from 'valibot';   (runtime)
src/lib/agentic/flue/tools-adapter.ts:68            import type * as v from 'valibot';  (type-only)
```

The runtime site builds the valibot schema that describes a tool's arguments
to the model.

**2. Is it classified correctly?** `dependencies` — correct, and it was
already in the tree transitively (via `@t3-oss/env-nextjs`, `@prisma/dev`
and `@hookform/resolvers`). Declaring it makes an existing phantom import
explicit rather than adding a new package to the image.

**3. Version + exposure risk.** `1.5.0` resolved. The repo's `overrides`
entry moved from a literal `^1.4.2` to `$valibot` — npm refuses an override
whose range differs from a direct dependency's (`EOVERRIDE`), and `$name` is
the idiom already used for `$undici` and `$postcss`. The practical effect is
unchanged: one valibot for the whole tree, now pinned to the version this
package.json declares rather than to a second hand-maintained number.

**Blast radius is bounded by where it sits.** A defect in the converted
schema cannot weaken enforcement: `runReadTool` validates every tool call
against the tool's **Zod** schema at its own step, and nothing in the
valibot path is on that route. The worst case is a misdescribed argument
list, which produces a rejected call rather than an unchecked one.

**4. Decision.** Adopt. Declare explicitly; keep the `$valibot` override so
the tree cannot split.

### Summary — 2026-09-20

| Package | Classification | Version | Decision |
|---------|----------------|---------|----------|
| `@flue/runtime` | `dependencies` (deliberately, see above) | `2.1.0` exact | Adopt; exact pin; re-review on any bump |
| `valibot` | `dependencies` ✓ | `^1.5.0` | Adopt; was transitive, now declared |

No new advisory is introduced by either. The production audit posture is
identical before and after, which is the claim this section exists to
record.

## Review — 2026-09-22 — the provider layer

The Flue driver's execution half constructs its own pi providers, which turns
a package that was transitive into one this repo imports directly.

### `@earendil-works/pi-ai` — `0.83.0` (exact)

**1. Where is it used?** Four import sites, three of them type-only:

```
src/lib/agentic/flue/providers.ts        createProvider, Model, Provider   (VALUE)
                                         .../api/anthropic-messages.lazy   (VALUE)
                                         .../api/openai-completions.lazy   (VALUE)
src/lib/agentic/flue/runtime-start.ts    import type { Provider }
src/lib/agentic/flue/runtime-bootstrap.ts  import type { Provider }
tests/unit/flue-runtime-bootstrap.test.ts  import type { Provider }
```

`providers.ts` is the only value importer. It builds the two providers this
deployment may register — `inflect-external` (Anthropic messages) and
`inflect-local` (an OpenAI-compatible gateway) — under our own ids, so that a
model specifier names a **residency** rather than a vendor.

**2. Is it classified correctly?** `dependencies`, and here the automatic
answer and the deliberate one agree: `providers.ts` holds real value imports
that execute, so `npm prune --omit=dev` stripping it would be a production
crash the moment `DRIVER_IMPLEMENTED.flue` flips. Same direction of risk as
`@flue/runtime`, without the type-only ambiguity that one had.

**3. Why it needs a section at all.** It was **already in the tree**, at the
same 0.83.0, as a transitive dependency of `@flue/runtime` (and of
`@earendil-works/pi-agent-core`, which requires `^0.83.0`). Declaring it adds
nothing to the image; it turns a phantom import into a real one, exactly as
the `valibot` entry did on 2026-09-20. An undeclared direct import resolves
only by hoisting luck, and breaks silently the day `@flue/runtime` stops
depending on it.

**4. Version + exposure risk.** Pinned EXACTLY, not a caret, for the reason
`@flue/runtime` is: this is the layer that **performs the network egress to
model providers** and resolves their credentials, so it should not cross a
version without somebody reading the diff. A caret would be nearly as tight
on 0.x — npm treats `^0.83.0` as patch-only — but "nearly" is not a property
worth relying on, and the exact pin states the intent rather than inheriting
it from semver's 0.x rule.

It qualifies for review on two of the three criteria at once: it performs
**network egress** to model providers, and it **parses untrusted input** —
every model response, including tool-call arguments, is decoded here before
anything else sees it.

**5. Residency.** The provider ids are ours and the auth resolvers close over
credentials passed in, rather than reading ambient `process.env` as pi's
built-in factories do. That is what keeps "this deployment has an external
credential" and "this deployment has an external route" the same fact — a key
merely present in the environment must not create a route under
`aiResidency: LOCAL_ONLY`.

### Summary — 2026-09-22

| Package | Classification | Version | Decision |
|---------|----------------|---------|----------|
| `@earendil-works/pi-ai` | `dependencies` ✓ | `0.83.0` exact | Declare; was transitive at the same version; exact pin |

No package is added to the image and no new advisory is introduced — the
resolved tree is byte-identical, and the lockfile diff is the single line that
records the root requirement.

## Re-running this review

When auditing the next batch of dependencies, copy the per-package
table shape above. The structural ratchet
`tests/guards/dependency-risk-review.test.ts` keeps the packages
reviewed here pinned where this document says they are — if
a future change moves one of them to `devDependencies`, downgrades a
major, or drops it, the guard fails and points back here. Add new
audited packages to that guard's `REVIEWED` map in the same diff
that reviews them.
