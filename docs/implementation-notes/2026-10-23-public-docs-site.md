# 2026-10-23 — Public docs site on GitHub Pages

**Commit:** see the pull request that adds `site/` and `.github/workflows/docs-site.yml`.

## Design

```
docs/**.md ──┐
CONTRIBUTING ├─► site/published-docs.json (ALLOWLIST, sidebar order)
             │            │
             │            ▼
             └──► site/scripts/stage-docs.js
                    1. refuse: NEVER_PUBLISH · FORBIDDEN_CONTENT · missing · untitled · duplicate
                    2. per doc: H1 → frontmatter title, editUrl → docs/ source
                    3. rewrite links: published → site page · unpublished doc → plain text
                                      other repo file → github.com · missing → text + warning
                    4. escape tag-shaped placeholders in prose (<DataTable>, <slug>)
                          │
                          ▼
                 site/src/content/docs/ (generated, gitignored)
                          │
                          ▼
                 astro build (Starlight, Pagefind search) → site/dist
                          │
            main + Pages enabled ─► actions/deploy-pages
```

The owner chose a public site with the deployment, production-VM and DPA-template
material excluded. The repository itself is public, so "excluded" means "not on
the site, not in its search", never "confidential".

## Files

| File | Role |
| --- | --- |
| `site/published-docs.json` | The allowlist and the sidebar |
| `site/scripts/stage-docs.js` | Policy, link rewriting and staging; pure functions exported for Jest |
| `site/astro.config.mjs`, `site/src/content.config.mjs` | Starlight project; sidebar read from the manifest |
| `site/pages/index.md` | Landing page, links written as repo paths and rewritten like any doc |
| `site/package.json`, `site/package-lock.json` | The site's own dependency tree |
| `.github/workflows/docs-site.yml` | Build on PRs that touch the inputs; deploy on main once Pages is enabled |
| `tests/guardrails/docs-site-publication.test.ts` | The policy over the real manifest, on every PR, with the owner's list restated |
| `tests/unit/docs-site-stage.test.ts` | Link rewriting, code preservation, placeholder escaping, every refusal |
| `docs/docs-site.md` | The contributor-facing explanation, itself published |

## Decisions

- **Allowlist, not denylist.** A denylist publishes every new doc by default. The
  allowlist means 27 classified docs are unpublished today, and each new one stays
  off until a person lists it.
- **Two exclusion mechanisms.** `NEVER_PUBLISH` records which docs the owner kept
  off by name. `FORBIDDEN_CONTENT` refuses a coordinate in any listed doc, which is
  what blocks eight otherwise-publishable docs today (`sub-processors.md`,
  `slos.md`, `ci-cd.md`, `agentic-iam-roadmap.md`, the two legacy-access
  recertification docs, `agentic-harness-scanner-dpia.md` and the TypeSafe notice).
  Scrubbing a line in one of them and listing it is how it gets published; the
  rule is not loosened.
- **The policy runs in the build AND in Ratchets.** The build is the step that
  writes what gets published; the guardrail runs on every PR, unfiltered, so a doc
  that drifts into naming a host path fails in the PR that wrote it.
- **Starlight, not Material for MkDocs.** Material for MkDocs entered maintenance
  mode in November 2025 with security fixes ending 2026-11-05, and its successor
  Zensical was 0.0.72 (alpha) on this date. Starlight is Node like the rest of the
  repo, maintained, ships Pagefind search, and treats `.md` as Markdown (no MDX
  brace evaluation, which these docs would break).
- **A separate package under `site/`.** The app's dependency tree, `npm audit`
  gate and lockfile stay untouched; Dependabot updates `site/` on its own entry.
- **Unpublished docs are rendered as plain text, not linked to GitHub.** Linking
  to them would put the excluded material one click from every page that
  mentions it. Code and other repo files do link to GitHub.
- **No `"type": "module"` in `site/package.json`.** The stager must be CommonJS
  for Jest and `.js` for ESLint (the repo config cannot lint `.cjs`).
- **The deploy job gates on `github.event.repository.has_pages`.** GITHUB_TOKEN
  cannot enable Pages, and a PAT that could would be a standing admin credential
  in CI. Until an admin enables Pages, the deploy is skipped and the build leaves
  a warning saying why.
- **Prose is rewritten a paragraph at a time.** An inline code span can wrap a
  line; per-line masking escaped `<old>` inside such a span on the first build.
