# 2026-09-17 — the tool-manifest pin rings a bell

**Issue:** #2561 (AGENTIC UI 1/4, Part D — "manifest pin changed")

## Design

Approving a tool-manifest pin is the widest act in the agentic subsystem. It
accepts a new tool DEFINITION — name, description, parameter schema — on behalf
of the whole tenant, and clears the MCP boundary's refusal for **every** agent at
once. The description inside a definition is instruction text delivered straight
into a model's context, which makes this the tool-poisoning surface (OWASP
ASI04). The act was permission-gated (`admin.agent_registry`), it named the
approver in a column, and it wrote a hash-chained `MCP_TOOL_MANIFEST_APPROVED`
audit row — and it told nobody. The button sits on one agent's Tools tab, so the
decision is taken from a per-agent page and lands tenant-wide.

Almost nothing here is new machinery. `src/app-layer/notifications/agentic.ts`
already had the emitter, the dedupe key, the recipient resolver, the in-app mute
and the bell/SSE path, with three callers. This adds a fourth `NotificationType`
member, one `COPY` entry, and one emit at the single write site.

Everything the bell needs was already computed inside the tenant transaction and
dropped at the return boundary: `changed` (the "the pin actually moved"
discriminator), `previousManifestHash`, `revision`, and a `ctx.userId` already
asserted non-null before any write.

Three properties are load-bearing:

- **Gated on `changed`.** The `changed: false` early return leaves before the
  pin write, the audit row and the emit, so a re-approval that matches the hash
  on file says nothing. A bell for a call that wrote nothing is how a recipient
  learns to dismiss this particular bell.
- **Addressed to the workspace, never to the approver.**
  `resolveAgenticRecipients(db, tenantId, null)` returns the ACTIVE OWNERs —
  correct for a tenant-wide accept, and no new recipient logic. The emitter's
  existing actor filter removes the person who clicked.
- **The description never appears.** Subject is `The tool "<name>"`. The module
  header already refuses the text in the audit row, the log line and the
  response; a bell row is one more reader and gets the same rule. The
  fire-and-forget catch logs `err.message` and never `String(err)`.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `AGENT_TOOL_MANIFEST_PIN_CHANGED`, declared before `GENERAL` beside the other three agentic members |
| `prisma/migrations/20260917160000_agent_manifest_pin_notification/migration.sql` | `ADD VALUE IF NOT EXISTS … BEFORE 'GENERAL'` |
| `src/app-layer/notifications/agentic.ts` | union member + `COPY` entry (which is also what puts the type on `/admin/notifications`) |
| `src/app-layer/usecases/mcp-tool-manifest.ts` | the emit, inside the tenant transaction, after `logEvent` |
| `tests/guardrails/enum-member-order-matches-migrations.test.ts` | the `NotificationType` sign-off's two verbatim sequences gain the member |
| `tests/unit/mcp-tool-manifest-pinning.test.ts` | the widened double and seven behavioural tests |

## Decisions

- **`BEFORE 'GENERAL'`, not a plain append.** Plain `ADD VALUE` appends last in
  migration order while the schema declares the member before `GENERAL` — the
  same member in two slots, which WIDENS `NotificationType`'s pre-existing
  drift. `BEFORE`/`AFTER` keeps the rolling-deploy property plain `ADD VALUE`
  has: nothing renamed, nothing dropped. Mutation-proved — stripping the
  `BEFORE` clause turns `enum-member-order-matches-migrations.test.ts` red on
  exactly this member's position, and the live Postgres ordinal order on a
  freshly migrated database matches the guard's statically reconstructed
  sequence.
- **Extending the sign-off snapshot is not signing off a new enum.** The
  guard's docblock rules out adding a NEW enum to `SIGNED_OFF` to escape a real
  drift. `NotificationType` is already there, both sequences are verbatim pins,
  and a legitimately placed member has to appear in both. That is maintenance of
  an existing entry; `BEFORE 'GENERAL'` is what makes it legitimate.
- **`entityId` is the TOOL NAME.** There is no per-pin surface and no row-level
  URL, and the day-granular key should collapse repeat approvals of one tool.
  The manifest hash would have been the other candidate; the key test pins the
  choice and goes red under that mutation.
- **`linkPath` is the register.** Pin state is tenant-wide data rendered on a
  per-agent Tools tab whose selection is local `useState`
  (`ToolManifestPins.tsx`, `TOOL_MANIFEST_PATH = '/admin/agents/tool-manifests'`),
  so there is no tenant-level manifest page to deep-link. Same answer the
  kill-switch bell gives.
- **No i18n, and no preference surface to build.** Bell rows are written at emit
  time and stored, so `next-intl` cannot reach them at render; both shipped
  bells changed zero `messages/*.json` keys and so does this one. The
  `/admin/notifications` in-app toggle is not hand-wired either — its catalogue
  is derived from this module's own `COPY` (`listInAppNotificationTypes`), so
  the `COPY` entry IS the wiring, and the mute is honoured above the write.
- **The test double had to be widened first, and that is the fix, not
  housekeeping.** The emit is fire-and-forget under an unconditional catch. With
  the previous `{ mcpToolManifestPin: pinTable }` double, `db.notification`
  would be `undefined`, the access would throw, the catch would swallow it, and
  the whole suite would stay green while the bell never rang. A fixture that
  cannot produce the failing input defeats its own proof. The workspace also
  needed a SECOND active OWNER: the approver is himself an OWNER, so a
  one-owner tenant filters him out as the actor and writes zero rows —
  indistinguishable from an emit that never happened.
- **One test's comment was corrected after measurement.** "A second approval on
  the same day adds no second row" was annotated as discriminating the tool name
  from the manifest hash. Mutated to `entityId: live.manifestHash` it stayed
  green — `approveToolManifest` resolves the definition from the BUILD, so both
  approvals accept the same definition and a hash key dedupes identically. The
  comment now says what the test actually proves and points at the key test,
  which does go red under that mutation.
