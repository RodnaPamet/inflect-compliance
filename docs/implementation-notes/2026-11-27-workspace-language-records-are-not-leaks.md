# 2026-11-27 — a record written in the workspace's language is not an English leak

**Commit:** `(this PR)` fix(mobile-audit): a record the server wrote in the workspace's own language is not an English leak

## Design

The nightly mobile audit's `englishLeaks` count rose 0 → 6 on both Bulgarian
configurations from 2026-11-25 (#5972), on these routes:

```
/t/[tenantSlug]/tasks                       /t/[tenantSlug]/issues
/t/[tenantSlug]/tasks/dashboard             /t/[tenantSlug]/issues/dashboard
/t/[tenantSlug]/notifications               /t/[tenantSlug]/audits/cycles/[cycleId]/readiness
```

Six routes, **one string** — read off the run's own `metrics.json` rather than
inferred from the commit range, which spanned fifty commits because the audit
compares against the last *successful* night:

```
[CATALOG]  Answer the NIS2 gap assessment questions for IT (72 questions)
[EMBEDDED] TSK-4 "Answer the NIS2 gap assessment questions for IT (72 questions)" вече е ваша отговорност.
```

It is a stored NIS2 gap-assessment **task title**. #5932 writes those titles in
the workspace's default language and added the template to the catalog as
`workspaceText.nis2GapTask.title` — and adding it to the catalog is what made
the detector start reporting it, because a stored string matching a catalog
message is how the detector identifies the product's own sentence (#5883).

So it was never a product defect. `Tenant.defaultLocale` defaults to `en` and
the audited workspace never sets it, so the title is stored in English **by the
owner's decision of 2026-11-24** (#5868): *a task is an editable record, so
unlike a stock notification it cannot be re-worded on read; its language is
chosen when the server writes it.* The detector could not tell "written in the
workspace's language, which is English" from "an interface string that leaked".

The fix teaches it the difference, and the asymmetry is the whole point:

```
                     workspace defaultLocale = en        = bg
  stored EN title    the record's own text  → clean      written in the wrong
                                                         language  → LEAK
```

`workspaceText.*` is exactly the namespace for text the server writes into a
record (NIS2 task titles, task-assigned e-mails, calendar events — the three
`workspaceTranslator` callers), so the matcher is built from that namespace in
**one** locale: the workspace's own. A page string it matches is the record's
correct text; the same string in a workspace whose default is the other
language is still reported.

## Files

| File | Role |
| --- | --- |
| `scripts/mobile-audit/leaks.ts` | `buildWorkspaceTextMatcher` / `loadWorkspaceTextMatcher` / `NO_WORKSPACE_TEXT`, and the two exclusions in `findEnglishLeaks` |
| `scripts/mobile-audit/resolve.ts` | `workspaceLocale` — reads `Tenant.defaultLocale` for the audited workspace |
| `scripts/mobile-audit/run.ts` | Builds the matcher once per run and threads it through `leakInputs` |
| `docs/mobile-audit.md` | The `englishLeaks` row records the exclusion and both directions of it |

## Decisions

- **One locale, the workspace's own — never a fallback to English.** A matcher
  that fell back to `en` when the locale file was missing would exclude the
  English renderings in a Bulgarian workspace, which is the one case this check
  exists to catch. `loadWorkspaceTextMatcher` reads the named locale's file and
  nothing else.

- **The namespace is the discriminator, because the value cannot be.** The
  title is in `messages/en.json` like every interface message, and it is a
  catalog message — that is *why* it was flagged. Only its key says it is
  record text, so the matcher reads `workspaceText.*` and nothing else.

- **Only the record's own text is removed, then what is left is judged.** The
  Bulgarian notification sentence carries the title inside it; stripping the
  matched span and judging the remainder means a sentence holding both a record
  and a real leak is still reported. Suppressing the whole sentence because it
  contained a record would have been the cheaper rule and the wrong one.

- **Two guards against a matcher that excludes more than the record.** A
  template whose literal text is under `WORKSPACE_TEXT_MIN_LITERAL` or is one
  word identifies nothing — `"{type}: {name}"` would match any "X: Y" on the
  page. And a placeholder-free value that is *also* a message under some other
  key stays judged: "Evidence review" is a calendar event type here and may be
  an interface label there. That second guard is load-bearing rather than
  theoretical — it is what keeps the calendar event types out of the excluded
  set, which is nine patterns and three values for `en`.

- **`tokenCount` counts words in any script.** The existing `words` helper is
  ASCII-only, which would have silently skipped every Bulgarian template and
  made the `bg` matcher empty — green for the wrong reason, since an empty
  matcher excludes nothing and the Bulgarian case would have "passed" without
  the rule ever running.

- **The regression is pinned by its own strings.** The test asserts the real
  catalog against the two strings the nightly reported, in three states: clean
  with the `en` matcher, a leak with the `bg` matcher, and a leak with no
  matcher at all — the last being the mutation proof that the rule, not an
  accident, is what clears the count.
