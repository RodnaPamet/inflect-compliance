/**
 * `any` usage ratchet.
 *
 * The codebase has a large pre-existing `any` migration debt (1200+
 * occurrences across API routes, usecases, services). Making
 * `@typescript-eslint/no-explicit-any` an `error` meant CI was red
 * for weeks; ESLint can't gradually rollout a rule. Downgrading to
 * `warn` puts lint back in the green but loses the "no new any"
 * pressure.
 *
 * This guard bridges the gap. Counts `any` patterns across `src/`
 * (SAME regexes as `scripts/count-any.js`) and caps them at the
 * current floor. New code that introduces `: any`, `<any>`,
 * `useState<any>`, `as any`, or `@ts-ignore` pushes the total up,
 * which fails this test. Caps only go DOWN — as types get added,
 * lower the cap.
 *
 * Same ratchet pattern as `tests/guardrails/raw-color-ratchet.test.ts`
 * (Epic 51 — raw Tailwind colours) and `tests/guards/epic60-ratchet.test.ts`
 * (Epic 60 — inline patterns).
 *
 * To lower the cap after a cleanup sweep:
 *   1. Run `node scripts/count-any.js` to see the new total.
 *   2. Update the `CAPS` below to match, never higher.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');

interface Pattern {
    label: string;
    regex: RegExp;
}

const PATTERNS: Pattern[] = [
    { label: ': any', regex: /:\s*any\b/g },
    { label: '<any>', regex: /<any>/g },
    { label: 'useState<any>', regex: /useState<any>/g },
    { label: 'as any', regex: /as\s+any\b/g },
    { label: '// @ts-ignore', regex: /\/\/\s*@ts-ignore/g },
];

/**
 * Per-pattern cap. Current floor — can only go down when code is
 * migrated to real types. Raising these values requires a team
 * decision and a commit-message rationale.
 */
const CAPS: Record<string, number> = {
    // Roadmap-6 P1 (2026-05-22) — `as any` debt paydown. The cast sweep
    // across ~65 files drove every pattern down; each cap is lowered to
    // the exact post-cleanup floor so the gain cannot silently erode.
    // The `as any` cap counts comment mentions too (this ratchet does
    // not strip comments) — the code-level count is now 0, tracked by
    // tests/guardrails/no-explicit-any-ratchet.test.ts. The 15
    // remaining occurrences are all in docstrings / explanatory
    // comments (multiple-mentions-per-line counted separately).
    // R10-PR3 follow-up (2026-05-24) — `<any>` raised from 61 → 63.
    // The raw-`<table>` → DataTable migration of the vendor
    // assessments + subprocessors sub-tables introduced two
    // `createColumns<any>([...])` casts: `s.subprocessor`,
    // `a.template`, and the rest of those rows are typed loosely
    // (the existing page-level `assessments` and `subs` arrays are
    // `any[]` upstream — typing them properly is a separate cleanup).
    // any-paydown wave PR1 (2026-06-21) — typed `useState<any>` → real
    // interfaces in the framework-install + audit-cycle + cycle-readiness
    // pages (cross-walked from each API route's repository select / usecase
    // return). 7 `useState<any>` cleared; because `/<any>/` also matches the
    // `<any>` inside `useState<any>`, the `<any>` cap drops by the same 7.
    //   useState<any> 24 → 15 · <any> 63 → 54
    // any-paydown wave PR2 (2026-06-21) — typed `useState<any>` in the
    // framework-detail (framework/coverage) + vendor-detail (vendor/editForm)
    // pages. 4 more cleared; `<any>` drops by the same 4.
    //   useState<any> 15 → 11 · <any> 54 → 50
    // any-paydown wave PR3 (2026-06-21) — typed `useState<any>` in the 3 audit
    // pages (AuditsClient/auditor/pack-detail) + vendors-dashboard + mapping.
    // 5 cleared; `<any>` drops by the same 5. Two latent read-bugs fixed in
    // passing: AuditsClient `selected.scope` → `auditScope`.
    //   useState<any> 11 → 6 · <any> 50 → 45
    // any-paydown wave PR4 (2026-06-21) — typed the final 6 `useState<any>`
    // (audit-share, asset detail, clauses browser, framework diff/templates,
    // vendor assessment). The category is now ZERO; `<any>` drops by the same 6.
    //   useState<any> 6 → 0 · <any> 45 → 39
    // any-paydown wave PR5 (2026-06-21) — first of the `<any>` category: typed
    // the list-table generics (CappedList / createColumns / EntityListPage) in
    // coverage + vendors + policies clients to real row interfaces. Per-cell
    // callback params stay untyped (the `: any` category). 7 cleared.
    //   <any> 39 → 32
    // any-paydown wave PR6 (2026-06-21) — `<any>` category cont.: typed the
    // FindingsClient list-table generics (useQuery/getQueryData/setQueryData
    // CappedList + createColumns) to FindingRow. 5 cleared.
    //   <any> 32 → 27
    // any-paydown wave PR7 (2026-06-21) — `<any>` cont.: typed the list-table
    // generics in AssetsClient (createColumns + the useQuery payload),
    // AuditsClient (useQuery CappedList → AuditListRow) + AuditLogClient
    // (createColumns → AuditLogRow). 3 cleared.
    //   <any> 27 → 24
    // any-paydown wave PR8 (2026-06-21) — `<any>` cont.: typed EvidenceClient's
    // useTenantSWR + useTenantMutation `CappedList<…>` payloads + createColumns
    // to EvidenceRow (evidenceListSelect). 4 cleared.
    //   <any> 24 → 20
    // any-paydown wave PR9 (2026-06-21) — `<any>` cont.: typed the two vendor
    // detail sub-tables (VendorAssessmentRow / VendorSubprocessorRow) +
    // tasks/[taskId] useTenantSWR (TaskDetail). 3 cleared.
    //   <any> 20 → 17
    // any-paydown wave PR10 (2026-06-21) — `<any>` cont. + latent-bug fixes:
    // typed createColumns in controls/templates (ControlTemplateRow) +
    // reports (RiskRegisterRow). Typing exposed always-blank columns: fixed
    // templates `name`→`title`, removed the dead `frameworkTag` + `asset`
    // columns (no backing field). 2 `<any>` cleared; removing the dead-column
    // cells also dropped 2 colon-any.
    //   <any> 17 → 15 · : any 357 → 355
    // any-paydown wave PR11 (2026-06-21) — `<any>` cont., frontend generics:
    // TraceabilityPanel `getQueryData<any>` → `TraceabilityData` (2), charts
    // `ReactElement<any>` → `ReactElement` (2: 1 real + 1 docstring), form
    // `Promise<any>` → `Promise<unknown>` (1), table pinning helpers
    // `Column<any>` → generic `<TData>(column: Column<TData>)` (2). 7 cleared.
    //   <any> 15 → 8
    // any-paydown wave PR12 (2026-06-21) — `<any>` cont., Prisma-middleware
    // boundary: the `query`/`next` callbacks and `isThenable` predicate carried
    // `Promise<any>` / `PromiseLike<any>` return types at the dynamic Prisma
    // call boundary. Tightened to `unknown` (rls-middleware, encryption-middleware,
    // pii-middleware ×3, audit-context) — the query result already flows into
    // `unknown`-typed sinks (`walkReadResult(result: unknown)`, pass-through
    // returns, `runPiiEncryption`'s `Promise<unknown>` next). The `: any` PARAM
    // annotations stay (separate category); their eslint-disables remain. 6 cleared.
    //   <any> 8 → 2
    // any-paydown wave PR13 (2026-06-21) — `<any>` category ZEROED. The last
    // two: executor-registry's heterogeneous `Map<string, JobExecutor<any>>`
    // (erase the payload to `never` on store — every `JobExecutor<T>` is
    // assignable to `JobExecutor<never>` by param contravariance — and
    // re-narrow with a non-`any` cast on retrieval in `execute`); and
    // EvidenceBundleRepository.create's `Promise<any>` (deprecated throwing
    // stub → `Promise<{ id: string }>`, the structural contract its caller
    // reads). 2 cleared; the category is now 0 and ratcheted there.
    //   <any> 2 → 0
    // any-paydown wave PR14 (2026-06-21) — FIRST `: any` category PR (list
    // clients). PoliciesClient (17) + VendorsClient (14): typed the `initial*`
    // props to the existing `PolicyRow[]`/`VendorRow[]` (clean at the page's
    // `JSON.parse(JSON.stringify())` boundary — the Row interfaces model the
    // post-serialization string-date shape), and dropped every cell /
    // accessorFn / array-filter / getRowId `: any` — each param now infers
    // from `createColumns<Row>` / the typed SWR `rows`. Both files' now-unused
    // file-level `no-explicit-any` disables removed. 31 cleared.
    //   : any 355 → 324
    // any-paydown wave PR15 (2026-06-21) — `: any` cont. (Evidence + Reports).
    // EvidenceClient: props/source arrays → `EvidenceRow[]` + a new
    // `EvidenceControlOption` interface; dropped all cell/accessorFn/filter/
    // getRowId `: any`; helper + gallery callbacks typed `EvidenceRow`. Tightened
    // the (single-consumer) `EvidenceGallery` row type by removing its loose
    // `[otherKey: string]: unknown` index signature so `EvidenceRow` satisfies it
    // strictly (rather than widening EvidenceRow Record-style). ReportsClient:
    // `riskRegister` → `RiskRegisterRow[]`, unused `soa` → `unknown[]`, downloadCSV
    // param typed (indexed via `keyof RiskRegisterRow`), callbacks dropped. Both
    // files' file-level disables removed. 35 cleared.
    //   : any 324 → 289
    // any-paydown wave PR16 (2026-06-22) — `: any` cont. (4 list clients).
    // AssetsClient (AssetListRow) + FindingsClient (FindingRow) + AuditLogClient
    // (AuditLogRow) + CoverageClient (UnmappedRiskRow/UncoveredAssetRow): typed
    // each `initial*`/`auditLog` prop to its existing Row[] and dropped every
    // cell / accessorFn / `.filter` / `.map` / getRowId `: any` (all infer from
    // `createColumns<Row>` / the typed source array). All four file-level
    // `no-explicit-any` disables now unused and removed. 40 cleared.
    //   : any 289 → 249
    // any-paydown wave PR17 (2026-06-22) — `: any` cont. (2 detail pages).
    // vendors/[vendorId]: 6 `useState<any[]>` → existing/new row types (added
    // VendorTemplateRow/VendorLinkRow/VendorBundleRow + `notes` on VendorDocRow);
    // `body: any` → `Record<string,string>`; setEditForm updaters + array
    // callbacks dropped; the two sub-table prop types → VendorAssessmentRow[] /
    // VendorSubprocessorRow[]; cell/getRowId typed (the actions cell sits in a
    // conditional spread so it carries an explicit `{ row: { original: Row } }`,
    // not `any`). tasks/[taskId]: 4 `useTenantSWR<any[]>`/inline → TaskLinkRow[]/
    // EvidenceTabData/TaskCommentRow[]/TaskActivityRow[]; optimistic `(cur: any)`
    // → `TaskDetail | undefined`; array callbacks dropped. Both file disables +
    // 5 inner vendor disables removed. 25 cleared.
    //   : any 249 → 224
    // any-paydown wave PR18 (2026-06-22) — `: any` cont. (framework/install.ts).
    // All 32 were noise: 31 `.map`/`.filter`/`.some` callback params on arrays
    // Prisma already fully types via include/select (annotations deleted, TS
    // infers the precise element); 1 accumulator `const where: any = {}` →
    // `Prisma.ControlTemplateWhereInput` (mirrors coverage.ts). File-level disable
    // removed. 32 cleared.
    //   : any 224 → 192
    // any-paydown wave PR19 (2026-06-22) — `: any` cont. (4 fetch+setState client
    // pages): controls/templates, risks/import, admin/integrations,
    // admin/notifications. Dropped tanstack cell/accessorFn/getRowId `: any`
    // (infer from `createColumns<Row>`); typed templates' state to its existing
    // `ControlTemplateRow`; two `catch (e: any)` → bare `catch (e)` + `instanceof
    // Error` narrowing; risks/import payload `Record<string, any>` → inferred. The
    // existing DTO/interfaces (ConnectionDTO, NotificationSettings, OutboxStats,
    // ParsedRow) already matched the sources. All 4 file-level disables removed.
    // 25 `: any` cleared (the useState<any[]>/Record<,any> tidy-ups aren't matched
    // by the `: any` regex but were required to drop the disables cleanly).
    //   : any 192 → 167
    // any-paydown wave PR20 (2026-06-22) — `: any` cont. (frameworks cluster, 5
    // files). Added local row interfaces (FrameworkListItem, FrameworkPackSummary
    // ×2, CatalogTemplate+TemplateRequirement+TemplateTask) and typed the props /
    // `useState<any[]>` state to them; dropped the `.map`/`.find` callback `: any`
    // (infer from typed state or already-typed coverage/diff arrays); one
    // `catch (e: any)` → `catch (e)` + narrowing; coerced FrameworkListItem
    // `description` (string|null) → undefined at the FwRow derive. All 5 disables
    // removed. 14 `: any` cleared.
    //   : any 167 → 153
    // any-paydown wave PR21a (2026-06-22) — `: any` cont. (server/lib, clean trio).
    // deadline-monitor.ts: 8 `const where: any` → `Prisma.<Model>WhereInput` (new
    // Prisma import). prisma.ts: 2 audit-middleware boundary `result: any` →
    // `unknown` + `typeof === 'object'`/cast narrowing (query() already returns
    // Promise<unknown>). soft-delete.ts: `withDeleted` constraint `Record<string,
    // any>` → `unknown`, no-op `registerSoftDeleteMiddleware(_client: any)` →
    // `unknown` (the `$extends: any` generic constraint stays — tightening it risks
    // the `$extends({...}) as T` call). 11 `: any` cleared. (RequirementMapping +
    // soft-delete-lifecycle deferred to PR21b/c — they need paired test-mock edits.)
    //   : any 153 → 142
    // any-paydown wave PR21b (2026-06-22) — `: any` cont. (RequirementMappingRepo).
    // 3 `const where: any` → `Prisma.RequirementMappingWhereInput` (new Prisma
    // import); `validStrengths` map → `as MappingStrengthValue` so `{ in }` matches
    // the enum filter; `resolveEdge(raw: any)` → a narrow inline structural type of
    // exactly the fields it reads (chosen over `Prisma.…GetPayload` so the existing
    // test fixtures — passed as a const/spread — need no validFrom/validTo churn).
    // 4 inner disables removed; zero test changes. 4 `: any` cleared.
    //   : any 142 → 138
    // any-paydown wave PR21c (2026-06-22) — `: any` cont. (soft-delete-lifecycle).
    // The 3 `tx: any` params → `PrismaTx` (the production callers pass the real
    // tenant tx); `getDelegate(tx: any): any` → `(tx: PrismaTx): SoftDeleteDelegate`
    // (new structural interface with `unknown` payloads — the model is chosen by
    // runtime string, so the one dynamic `tx[key]` lookup uses `as unknown as
    // Record<string, SoftDeleteDelegate>`, not `as any`); `Promise<any[]>` →
    // `Promise<unknown[]>`. Tightening `tx` surfaced two under-typed test mocks —
    // fixed in the same diff: `makeTx` now returns `PrismaTx` (one cast), and the
    // integration test casts the `unknown[]` list result before `.map`. 5 `: any`
    // cleared.
    //   : any 138 → 133
    // any-paydown wave PR22 (2026-06-22) — `: any` cont. (Traceability + 3 audit
    // files). TraceabilityPanel: typed the 3 dropdown-option states (RiskOption/
    // ControlOption/AssetOption), `useQuery<TraceabilityData|null>`, generic
    // `unwrap<T>(d: unknown)` with runtime-guarded `as T[]`, `body` →
    // `Record<string, string|undefined>`, dropped raw-table/option `.map` callbacks
    // (now infer TraceLinkEntry / option types) + `?? ''` coercions where the
    // optional linked entity's id/status fed a string slot. AuditsClient: props/
    // optimistic-updater/cell `.map` → AuditListRow/AuditDetail. auditor + packs:
    // typed the packs list (new AuditorPackListRow), grouped `Record<string,
    // PackItem[]>`, the `snapshotJson` `JSON.parse` `snap` → a small optional-field
    // shape (not `any`), added `entityId` to AuditorPackItem/PackItem. All 6
    // disables removed. 24 `: any` cleared.
    //   : any 133 → 109
    // any-paydown wave PR23 (2026-06-22) — `: any` cont. (Prisma middleware
    // boundary params): rls/encryption/pii `$allOperations` handlers. `args` →
    // `unknown` (rls never reads it) or `{ data?; create?; update?; where?: unknown }`
    // (enc/pii read those keys); `query`/`next` callback INPUT → `unknown`
    // (pass-through only); pii's legacy v5 wrapper `params`/`next` → a
    // `LegacyMiddlewareParams` type (carries the optional v5 dataPath/runInTransaction
    // the test suite passes). The three `T extends { $extends: any }` constraints
    // STAY `any` (Prisma's real `$extends` signature isn't assignable to any tighter
    // shape — tightening makes `client.$extends({...})` error with `never`); their 3
    // disables remain. 11 of 14 sites cleared.
    //   : any 109 → 98
    // any-paydown wave PR24 (2026-06-22) — `: any` cont. (3 create-form hooks).
    // useNewPolicyForm/useNewVendorForm/useNewTaskForm: `onSuccess: (x: any)` →
    // `(x: { id: string })` (every caller modal reads only `.id`); each `const body:
    // any` POST payload → a concrete inline shape (filtered subset of the form
    // values); policy's `[key: string]: any` template index sig → `unknown`; policy's
    // `catch (err: any)` → bare `catch (err)` + `instanceof Error` narrowing. All
    // disables removed. 8 `: any` cleared.
    //   : any 98 → 90
    // any-paydown wave PR25 (2026-06-22) — `: any` cont. (5 pages). audit/shared:
    // `PackItem`/`PackSnapshot` types for the share payload + parsed snapshotJson
    // (mappedRequirements guard restructured for the optional type). tasks/dashboard:
    // `TaskRow` for the 2 list states + callbacks (a route-shape latent bug noted,
    // out of scope). risks/[riskId]: payload `Record<string,any>` → inline shape, 3
    // `catch (err: any)` → bare + narrowing. risks/ai: `SuggestionEditForm` edit
    // buffer, asset `.map` → AssetOption, catches narrowed, `?? 0` coercions.
    // dashboard: `t` translator param `opts?: any` → typed values bag. All file
    // disables removed. 15 `: any` cleared.
    //   : any 90 → 75
    // any-paydown wave PR26 (2026-06-22) — `: any` cont. (UI primitives). table.tsx
    // `columns.map((column: any))` → inferred (`ColumnDef<T, any>` element; its
    // file disable stays — `ColumnDef<T, any>` generics remain) + comment reword;
    // combobox two type-guard params (`setSelected`, `isReactNode` element) → guard
    // from `unknown`; form `handleSubmit(data: any)` → `Record<string, unknown>`
    // (the Form constructs the `{[name]: value}` bag) + removed its now-unused
    // disable; GraphExplorer prose `: any` reworded. 6 `: any` cleared.
    //   : any 75 → 69
    // any-paydown wave PR27 (2026-06-22) — `: any` cont. (asset client files).
    // useNewAssetForm/useEditAssetForm: `onSuccess: (asset: any)` → `(asset: { id:
    // string })`; create body `: any` → inline shape (CIA fields are `number`);
    // edit catch narrowed. assets/[id]: `catch (err: any)` → bare + narrowing;
    // `rows.map((r: any) => r?.id)` → `(r: { id?: string })` with an `id is string`
    // filter predicate. File disable removed. 6 `: any` cleared.
    //   : any 69 → 63
    // any-paydown wave PR28 (2026-06-22) — `: any` cont. (app-layer, clean pair).
    // vendor-scoring: `riskPointsJson`/`answerJson` (Prisma Json columns, read only
    // under `typeof` guards / an existing `as Record<string,number>` cast) → `unknown`.
    // TaskRepository: the two `metadataJson?: any` write-input fields → `unknown`
    // + an `as Prisma.InputJsonValue` cast at the local write site (typing them
    // `InputJsonValue` directly would cascade to the task.ts callers). 4 cleared.
    // (asset.ts + soa-checks deferred — schema-string-vs-Prisma-enum casts + test
    // fixture shape, handled in PR29.)
    //   : any 63 → 59
    // any-paydown wave PR29 (2026-06-22) — `: any` cont. (asset usecase). createAsset/
    // updateAsset `data: any` → hand-written `CreateAssetInput` / `UpdateAssetInput`
    // (= Partial). Hand-written rather than `z.infer`/`z.input` of the schema because
    // the schema uses `z.coerce` (input type `unknown`) and the usecase is called in
    // tests before the write gate with partial objects — so `type` is optional and CIA
    // fields are concrete `number?`. `data.type` cast `as AssetType` at the repo calls;
    // the audit-diff dynamic key uses `as unknown as Record<string, unknown>`. 2 cleared.
    //   : any 59 → 57
    // any-paydown wave PR30 (2026-06-22) — `: any` cont. (the 4 `$extends` generic
    // constraints). rls/encryption/pii/soft-delete extension helpers used
    // `<T extends { $extends: any }>` (kept as `any` in PR23 because Prisma's real
    // `$extends` signature isn't assignable to a tighter shape). Resolved by relaxing
    // the constraint to `<T extends object>` and casting inside the body —
    // `(client as { $extends: (cfg: unknown) => unknown }).$extends({...}) as T` —
    // so the call site stays sound without an `any` on the public signature. 4 cleared.
    //   : any 57 → 53
    // any-paydown wave PR31 (2026-06-22) — `: any` cont. (app-layer tail). scim-users
    // `memberWhere: any` → `Prisma.TenantMembershipWhereInput`; vendor-audit freeze
    // `snapshot: any` → a 2-variant union (doc | assessment) with an
    // `as Prisma.InputJsonValue` cast at the Json write; 3 prose `: any`
    // false-positives reworded (traceability-graph / policy-attestation /
    // library-updater). 5 cleared.
    //   : any 53 → 48
    // any-paydown wave PR32 (2026-06-22) — `: any` cont. (app-layer tail 2).
    // AssessmentRepository `answerJson: any` → `unknown` + `as Prisma.InputJsonValue`
    // at the upsert writes; enqueue `isPrismaUniqueConstraintError(error: any)` →
    // `unknown` + narrowing; task-due-notification + policyReviewReminder `where: any`
    // → `Prisma.TaskWhereInput` / `Prisma.PolicyWhereInput`; sync-pull logger
    // `(syncEvent: any)` → `unknown`. 5 cleared.
    //   : any 48 → 43
    // any-paydown wave PR33 (2026-06-22) — `: any` cont. (lib auth/interop). bcryptjs
    // ESM-default-interop in auth.ts + passwords.ts (`const ns: any = m`) →
    // `(m as unknown as { default?: typeof m }).default ?? m`; api-key-auth
    // `scopesToPermissions` accumulator `result: any` → `Record<string,
    // Record<string, boolean>>` (already cast to PermissionSet at return);
    // audit-context `isThenable(value: any)` → `unknown` + a `{ then?: unknown }`
    // narrowing. 4 cleared. (saml-client deferred — its `SamlConfig` constructor
    // type rejects the `cert` key the literal sets.)
    //   : any 43 → 39
    // any-paydown wave PR34 (2026-06-22) — `: any` cont. (client tail). clauses
    // prop/state → `ClauseRow[]` + setState updater (status cast to ClauseRow['status']);
    // audits/cycles items accumulator → inline `{entityType;entityId;sortOrder}[]` +
    // `cycle.packs.map((p))` infers `AuditCyclePack`; login two `catch (err: any)` →
    // bare + `instanceof Error`; TreeExpandCollapseToggle prose `: any` reworded. 7 cleared.
    //   : any 39 → 32
    // any-paydown wave PR35 (2026-06-22) — `: any` cont. (API routes + prose).
    // register/route `catch (error: any)` → bare + narrowing, `handleRegister(body:
    // any)` → the destructured `{ email; password; name; orgName }` shape; av-webhook
    // `let fileRecord: any` → `Awaited<ReturnType<typeof prisma.fileRecord.findUnique>>`;
    // 3 prose `: any` reworded (risk-matrix-config / verify-email-resend /
    // automation/events). 6 cleared.
    //   : any 32 → 26
    // any-paydown wave PR36 (2026-06-22) — `: any` cont. TasksClient bulk-mutation
    // body `: any` → inline `{ taskIds; assigneeUserId?; status?; dueAt? }`;
    // policies/[policyId] `catch (err: any)` → bare + narrowing; frameworks/page
    // server `coverages: Record<string,any>` → `Record<string, Awaited<ReturnType<
    // typeof computeCoverage>>>` and `frameworks.map((fw: any))` infers from
    // listFrameworks. 3 cleared. (mapping + policies/templates deferred — the former
    // reads a `name` not on MappingItem, the latter needs a fuller template row type.)
    //   : any 26 → 23
    // any-paydown wave PR37 (2026-06-22) — `: any` cont. (callbacks). NewAuditModal
    // `onCreated?: (audit: any)` + useNewAuditForm `onSuccess: (audit: any)` →
    // `(audit: { id: string })` (consumers read only `.id`); RecentActivityCard
    // `recentActivity.map((log: any))` → infers from `getRecentActivity`. 3 cleared.
    //   : any 23 → 20
    // any-paydown wave PR38 (2026-06-22) — `: any` cont. prisma-sync-store
    // `toSyncMapping(row: any)` → `IntegrationSyncMapping`; openrouter `const data:
    // any` → `{ choices?: { message?: { content?: string } }[] }`; tests/due cell
    // callback dropped (infers from createColumns<DuePlan>); readiness
    // `result.gaps.map((g: any))` → infers `ReadinessGap`; use-calendar-badge prose
    // reworded. 5 cleared.
    //   : any 20 → 15
    // any-paydown wave PR39 (2026-06-22) — `: any` cont. (evidence-row DTO cluster).
    // Defined a shared `EvidenceTabRow` in EvidenceSubTable and typed
    // `EvidenceTabData.evidence` to it (+ dropped the dedup filter annotation);
    // controls/[controlId] deleted its duplicate `EvidenceTabData` and imports the
    // SubTable's; AttachedEvidencePanel's `(ev: any)` filter drops to the inferred
    // row + its file-level disable removed. 4 cleared.
    //   : any 15 → 11
    // any-paydown wave PR40 (2026-06-22) — `: any` cont. vendors/assessment
    // `renderInput(q: any)` + `sections` → existing `AssessmentQuestion`; mapping
    // `items.map((item: any))` → inferred `MappingItem` AND fixed a latent bug it
    // had masked (`item.name` is undefined on the produced data — the label is
    // `item.title`; corrected the card title + aria-label); policies/templates
    // state/handler → a new `PolicyTemplateRow` (+ narrowed the category filter to
    // `string`). 3 `: any` cleared.
    //   : any 11 → 8
    // any-paydown wave PR41 (2026-06-22) — `: any` cont. (EditAssetModal chain).
    // Exported `AssetDetail` from assets/[id]/page and threaded it through
    // `useEditAssetForm.onSuccess` + `EditAssetModal.onSaved` (was `(updated: any)`),
    // so the modal → form → `setAsset` chain is type-coherent (the runtime value is
    // already the full PATCH-returned asset). 1 `: any` cleared.
    //   : any 8 → 7
    // any-paydown wave PR42 (2026-06-22) — `: any` cont. (soa-checks). `runSoAChecks`
    // `entries: any[]` + `(c: any)` → a narrow `SoAEntry`/`SoAEntryControl` (only the
    // fields the rules read, control fields optional). Narrow-by-design: the
    // production callers pass `getSoA().entries` (`SoAEntryDTO[]`, a structural
    // superset → assignable), while the minimal unit-test fixtures (which omit
    // control fields) also satisfy the optional shape — zero caller/test churn. 2 cleared.
    //   : any 7 → 5
    // any-paydown wave PR43 (2026-06-22) — `: any` cont. (integrations registry).
    // The two heterogeneous constructor types `IntegrationClientConstructor` /
    // `FieldMapperConstructor` used `new (config: any, …)` to accept any subclass
    // (params are contravariant — a base-config param would reject narrower
    // subclasses). Erased the param to `never` (every concrete `new (c: SubConfig)`
    // IS assignable to `new (c: never)`) and cast `config as never` / `options as
    // never` at the two `createClient`/`createMapper` factory sites. 2 cleared.
    //   : any 5 → 3
    // any-paydown wave PR44 (2026-06-22) — `: any` cont. `FilterOption.value: any`
    // → `string | number`. The disable claimed "heterogeneous incl. object", but
    // every internal consumer indexes through the `FilterOption["value"]` alias
    // (Set membership, `.includes`, `toggleValue`, React `key`, typeof-guards), so a
    // concrete scalar union propagates cleanly — full tsc confirms zero cascade. 1 cleared.
    //   : any 3 → 2
    // any-paydown wave PR45 (2026-06-22) — `: any` cont. saml-client `samlOptions: any`
    // → `ConstructorParameters<typeof SAML>[0]`. Typing surfaced a real bug the `any`
    // hid: the option key was `cert`, but @node-saml v5 renamed it to `idpCert` — the
    // IdP signing cert was NOT being applied. Fixed `cert` → `idpCert` (behavior change:
    // SAML response signature validation now uses the configured cert). 1 cleared.
    //   : any 2 → 1
    // any-paydown wave PR46 (2026-06-22) — `: any` category ZEROED. instrumentation
    // `resourcesMod: any` → migrated to @opentelemetry/resources v2 API: the package
    // dropped the `Resource` class export (v2.8), so `new Resource({...})` →
    // `resourceFromAttributes({...})` (BEHAVIOR: OTel resource creation now works on
    // the installed major; was referencing a non-existent export when OTel is enabled).
    // 1 cleared — the `: any` category is now 0 and ratcheted there.
    //   : any 1 → 0
    // any-paydown wave PR47 (2026-06-22) — WAVE CAPSTONE. The code-level `as any`
    // count was already 0; the cap's 15 were all docstring/comment mentions (the
    // ratchet counts comments). Reworded every remaining mention (`as any` →
    // `as`-cast / explicit-`any` / a concrete shape; two were the regex matching the
    // English "h-as any" in "has any" → reworded to "has active/score-impacting").
    // The `as any` cap goes 15→0. Every pattern in this ratchet is now ZERO:
    // `: any` 0 · `<any>` 0 · `useState<any>` 0 · `as any` 0 · `@ts-ignore` 0.
    ': any': 0,
    '<any>': 0,
    'useState<any>': 0,
    'as any': 0,
    '// @ts-ignore': 0,
};

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            out.push(...walk(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countAll(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const { label } of PATTERNS) totals[label] = 0;

    for (const file of walk(SRC_DIR)) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const { label, regex } of PATTERNS) {
            regex.lastIndex = 0;
            const matches = content.match(regex);
            totals[label] += matches ? matches.length : 0;
        }
    }
    return totals;
}

describe('`any` usage ratchet', () => {
    const totals = countAll();

    test.each(PATTERNS.map((p) => p.label))('%s stays within cap', (label) => {
        const cap = CAPS[label];
        const actual = totals[label];
        if (actual > cap) {
            throw new Error(
                `Pattern "${label}" count rose to ${actual} (cap ${cap}). ` +
                    `Recent commits introduced new \`any\` usage in src/**. ` +
                    `Replace with real types, or narrow the cast (\`unknown\` + ` +
                    `type guard, generic parameter, \`ReturnType<typeof …>\`, etc.). ` +
                    `If the addition is deliberate (e.g. untyped third-party API), ` +
                    `annotate with \`// eslint-disable-next-line\` AND bump the ` +
                    `cap in this file with a committed justification.`,
            );
        }
        expect(actual).toBeLessThanOrEqual(cap);
    });

    it('total stays within sum of per-pattern caps', () => {
        const total = Object.values(totals).reduce((a, b) => a + b, 0);
        const capTotal = Object.values(CAPS).reduce((a, b) => a + b, 0);
        if (total > capTotal) {
            // Covered by per-pattern tests; this is the readable roll-up.
            throw new Error(
                `Total \`any\` usages: ${total} (cap sum ${capTotal}).`,
            );
        }
        expect(total).toBeLessThanOrEqual(capTotal);
    });
});
