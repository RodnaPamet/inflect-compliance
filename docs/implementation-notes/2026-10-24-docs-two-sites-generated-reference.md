# 2026-10-24 — Two docs sites, and a developer reference generated from the code

**Commit:** see the pull request that adds `site/users/`, `site/developers/` and
`scripts/docs-reference/`.

## Design

```
docs/user/**  ──► site/users/manifest.json ──┐
                                             ├─► site/scripts/stage-docs.js
docs/**  ─────► site/developers/manifest.json┘     SITES: which folders each site may list
docs/reference/*.md ({{generated:<name>}})          one home per doc · NEVER_PUBLISH
        ▲                                           FORBIDDEN_CONTENT · route: · {{ui:}}
        │ fragments                                 cross-site link map (repo path → href)
scripts/docs-reference/generate.ts ──► site/.generated/*.md
  roles.ts       getPermissionsForRole × Role / OrgRole
  inventory.ts   every page.tsx, placed by SidebarNav.tsx
  page-actions.ts  a page's files + product components it imports
                   → fetch/apiGet/useTenantSWR/… URLs → api-routes.ts match
                   → requirePermission key of the route reached
  refusals.ts    error classes, DomainErrorCode, every named `reason`
                          │
                          ▼
  astro build --root users ──► site/users/dist ──┐  assemble.js
  astro build --root developers ──► …/dist ──────┴─► site/dist (help at root,
                                                       developers at /developers/)
```

One Pages deployment, two Starlight roots sharing `site/node_modules`. The help
site is at the repository's Pages root because that is the address users are
sent to; the developer site lives under it at `/developers/`.

## Files

| File | Role |
| --- | --- |
| `site/scripts/stage-docs.js` | `SITES` config; per-site expansion and refusals; cross-site link map; `{{generated:}}` expansion |
| `site/scripts/astro-site.mjs` | The Starlight config both roots share, parameterised per site |
| `site/{users,developers}/astro.config.mjs` | Each site's config: title, base, social links |
| `site/{users,developers}/manifest.json` | Each site's allowlist and sidebar (developers' was `site/published-docs.json`) |
| `site/{users,developers}/index.md` | Landing pages |
| `site/scripts/assemble.js` | Copies the two builds into one `site/dist` |
| `docs/user/guide/govern/risks.md` | The first page guide, moved from `docs/guide/` and stripped of engineering detail |
| `docs/reference/*.md` | Four reference pages: introduction + one generated directive each |
| `scripts/docs-reference/*.ts` | The generator: syntax-only TypeScript AST reads over a git-listed population |
| `tests/unit/docs-reference.test.ts` | Generator behaviour, including the role matrix against the real `getPermissionsForRole` |
| `tests/guardrails/docs-accuracy.test.ts` | `docs/user/` and `docs/reference/` classified `authoritative` by path |
| `tests/guardrails/docs-site-publication.test.ts` | Both manifests, one home per doc, both landing pages |

## Decisions

- **Two sites, not one site with two sections.** The owner rejected the first
  page guide as written for engineers, then asked for the whole help site to be
  user-only. Two sidebars and two search indexes are what keep an engineering
  page from turning up in a user's search; one site with a "Developers" section
  would still mix them.
- **One home per doc, decided by path.** The help site publishes only
  `docs/user/` and the developer site never does, so where a doc appears follows
  from where it is written. A doc listed by both manifests stops the build rather
  than appearing twice under two addresses.
- **The help site has no edit link and no GitHub link.** Its readers are not
  contributors. The developer site keeps both.
- **The reference is generated on every build, never committed.** A committed
  table is derived data beside its source and rots (the `counts` header lesson).
  The fragments go to a gitignored directory and a missing one stops the build,
  so a reference page can never ship without its generated half.
- **Syntax-only parsing, no type checker.** `ts.createSourceFile` per file keeps
  the generator to seconds and free of `tsconfig` resolution. What it cannot
  follow (a URL built in another module, a dynamic route segment from a prop) is
  listed as unmatched under its page with the reason, never dropped. Today 660 of
  695 calls match.
- **Coverage is reported, not gated** (owner decision 3 of the expansion plan).
  The generator prints the figures and emits GitHub notices; the build passes at
  any figure.
- **The role matrix calls the real resolver.** Reading `permissions.ts` as text
  would reproduce whatever the parser understood; calling
  `getPermissionsForRole` for every enum value is what the product does.
- **The workflow now runs on `src/` and the `Role` enum.** The reference changes
  when they do. The docs build is not a required check, so a code PR that makes
  the reference fail to generate shows red without blocking.
