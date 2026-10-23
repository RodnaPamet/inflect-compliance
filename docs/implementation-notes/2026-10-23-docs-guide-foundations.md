# 2026-10-23 — Docs site: page-guide foundations

**Commit:** `docs(site): page-guide foundations — folders, label tokens, checked routes`

## Design

Phase 1 of the docs-site expansion plan. Before about 154 page guides can be
written, the site needs a place to put them, a template, and two checks that
let a guide follow the app instead of drifting from it.

```
docs/guide/govern/risks.md ──► stage-docs.js ──► src/content/docs/guide/govern/risks.md
   route: /t/[tenantSlug]/risks      │  route ∈ appRoutes(src/app/**/page.tsx) ?
   # {{ui:risks.title}}              │  {{ui:…}} ∈ messages/en.json ?
                                     │  else: refuse the build
site/published-docs.json             │
   { group: "User guide",            ▼
     label: "{{ui:nav.govern}}",   sidebar: User guide › Govern › Risk Register
     docs: ["docs/guide/govern/"] }         Developers › (the 11 existing sections)
```

- **Groups.** Each manifest section names a `group`. Groups nest the sections in
  the sidebar, in the order their first section appears. The 11 existing
  sections moved under "Developers" with no change to any page address.
- **Folder entries.** `docs/guide/` and `docs/how-to/`, or a folder inside them,
  may be listed as a folder. It adds every `.md` under it, in path order, that
  the manifest does not already list by name. A folder anywhere else is refused
  and expands to nothing.
- **Path classification.** Both folders are `authoritative` by path in
  docs-accuracy, like `docs/implementation-notes/` is `historical`.
- **`route:` frontmatter.** Required under `docs/guide/`, checked against every
  `page.tsx` with route groups dropped, and printed at the top of the page as the
  address a user sees.
- **`{{ui:<key>}}` tokens.** Resolved from `messages/en.json` in prose, headings,
  tables, titles and section labels, never inside code.
- **Sample guide.** `docs/guide/govern/risks.md`, written against
  `RisksClient.tsx`, the bulk routes and their usecases.

## Files

| File | Role |
| --- | --- |
| `site/scripts/stage-docs.js` | Groups, folder expansion, frontmatter, routes, tokens; stages in memory and refuses before writing |
| `site/astro.config.mjs` | Builds the grouped sidebar through the stager's own `repoIo()` |
| `site/published-docs.json` | `group` on every section; the User guide › Govern section |
| `site/pages/index.md` | Sends product users to the user guide |
| `docs/guide/govern/risks.md` | The first page guide |
| `docs/docs-site.md` | "Writing a page guide": template, route, tokens |
| `.github/workflows/docs-site.yml` | Also builds on `messages/en.json` and `src/app/**` |
| `tests/guardrails/docs-accuracy.test.ts` | `docs/guide/` and `docs/how-to/` are authoritative by path |
| `tests/guardrails/docs-site-publication.test.ts` | Expands folders from git; path-classified guides count as classified |
| `tests/unit/docs-site-stage.test.ts` | Folders, groups, tokens, frontmatter, routes |

## Decisions

- **Tokens and routes are checked by the docs build, not by the guardrail.** The
  guardrail runs in Ratchets on every pull request. If it resolved tokens, a
  label rename in the app would fail a code change until somebody edited a doc,
  which is the "never gate CI on prose" failure this repo has already paid for
  once. The docs build is not a required check, so a broken token shows red on
  the PR that caused it without blocking it. That follows decision 3 of the
  expansion plan (coverage is advisory).
- **A message with ICU arguments is refused, not printed.** `{count} risks` is a
  sentence the app fills in. Printing it would show the braces, and there is no
  value to fill them with.
- **Labels are escaped**, including `|`, because guides put labels in tables.
- **Ordering by explicit listing, not frontmatter.** A guide's sidebar position
  is set by listing it before its folder. An `order:` key would be a second
  ordering mechanism, and the only frontmatter key is the one that is checked.
- **Bulk delete is offered to every role.** The Risks page shows the selection
  bar's Delete action to every role, while `POST /risks/bulk/delete` requires
  `admin.manage`. The guide documents what happens: the rows come back with
  "Bulk action failed". It does not change the page, which is outside this
  change.
