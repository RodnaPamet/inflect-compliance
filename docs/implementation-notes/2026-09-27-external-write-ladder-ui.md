# 2026-09-27 — the external-write ladder gets an operator surface (#2861)

**Commit:** `<pending> feat(agentic): an operator surface for the external-write ladder`

## Design

The storage and the OWNER-gated route landed in the sibling PR. This is the page
that makes the rung settable by a person instead of by `curl`.

That gap is not hypothetical, and it is why this ships beside the route rather
than after it. Two precedents in this repo:

- `WriteLadderClient`'s own docstring: *"The route has existed since the ladder
  shipped; nothing in the product called it. So the only way to move a tenant
  from DISABLED to DRY_RUN was a hand-made HTTP request from someone holding an
  OWNER session — which meant the mandated seven-day observation could not be
  STARTED through the product."*
- Defect #3 of the 2026-09-26 chain: the external-tool approval API shipped with
  no UI at all, and approving required a hand-written `fetch` in a browser
  console.

```
/t/<slug>/admin/external-write-policy/<connectionId>
  ↑ linked from /agents/external-tools, per connection
```

## Files

| file | role |
| --- | --- |
| `…/admin/external-write-policy/[connectionId]/ExternalWriteLadderClient.tsx` | the surface |
| `…/admin/external-write-policy/[connectionId]/page.tsx` | OWNER gate + `use(params)` |
| `…/agents/external-tools/ExternalToolsClient.tsx` | the inbound link |
| `messages/en.json`, `messages/bg.json` | `admin.externalWriteLadder.*` + one label |
| `tests/rendered/external-write-ladder.test.tsx` | 9 assertions |

## Decisions

- **The refusal is rendered, not just the disabled state.** The GET returns a
  reason per rung precisely so a control can explain itself; greying one out in
  silence is how an operator concludes the feature is broken and goes looking for
  a bug that is not there.

- **The widen control is disabled by the CEILING as well as by the refusal
  string.** Not instead of. The identity page carries the scar: a control gated
  only on the derived string sits ENABLED the moment the server changes how it
  words a refusal — and for a while its joiner widen button sat enabled directly
  beneath a notice saying the subsystem did not exist. A rung the runtime cannot
  honour is not widenable whatever the text says.

- **Narrowing is one click and never confirmed.** Widening grants standing
  authority to change something in a system that is not ours; narrowing takes it
  away and is the emergency stop. A dialog in front of the stop is a reason to
  hesitate at the moment nobody should. The asymmetry is deliberate.

- **`tone="warning"`, not `danger`.** This repo reserves `danger` for the
  irreversible. Widening is reversible by construction — narrowing is always
  permitted and sits beside the button — and dressing a reversible act as an
  irreversible one spends the strongest signal the design has on the wrong thing.

- **The ceiling notice and the per-rung refusal are mutually exclusive.** Both
  would put two sentences making the same point in different words inside one
  card. The notice wins because it is a standing fact about the build rather than
  a transient verdict.

- **`LADDER` is imported, never respelled.** A local union of the same four
  strings is how a client keeps offering a rung the ladder has retired. The
  module carries no server imports, so a client component can hold it.

- **`Link` + `buttonVariants`, not `<Button href>`.** The Button primitive renders
  a `<button>` and has no `href` — `tsc` caught the first attempt. Beyond styling,
  a real anchor is middle-clickable, focusable in document order, and announced as
  a link.

- **The inbound link is NOT gated on the owner permission.** The page behind it
  carries `RequirePermission` with an owner-specific message. A link hidden from
  an ADMIN would leave them unable to discover that the setting exists or who can
  change it, which is a worse answer than a clear refusal.

## Two things the verification caught that the code did not

- **`agents.externalTools`, not `admin.externalTools`.** The breadcrumb and the
  link label both reached for a key under the wrong namespace. The breadcrumb
  would have rendered the raw key as a label; nothing would have thrown.

- **A pattern in my own test command matched no file.** I ran thirteen guard
  paths and twelve suites executed — `i18n-keys-resolve` lives under
  `tests/guards/`, not `tests/guardrails/`, and jest treats a non-matching path
  as an empty selection, which is a PASS. Checked each path existed, then ran the
  missing one on its own.

## Risk assessment and rollback

STANDARD. One new page and client component, one link added to an existing page,
message keys in both locales. No schema change, no migration, no API change — the
route it drives shipped in the sibling PR. The page is OWNER-gated client-side and
the route is OWNER-gated server-side, so an ADMIN reaching it sees a refusal that
names who can help rather than a load error.

Rollback is reverting the commit; the route and the column it drives are
unaffected and keep working by `curl`, which is the state this replaces.
