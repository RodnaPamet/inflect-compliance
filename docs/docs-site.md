# How the documentation sites are built

One GitHub Pages deployment carries two separate documentation sites, each with
its own navigation and search:

| Site | Address | For | Built from |
| --- | --- | --- | --- |
| Help | [rodnapamet.github.io/inflect-compliance](https://rodnapamet.github.io/inflect-compliance/) | People who use the product | `docs/user/` only: page guides, how-tos and runbooks |
| Developers | [rodnapamet.github.io/inflect-compliance/developers](https://rodnapamet.github.io/inflect-compliance/developers/) | People who build, run or integrate with it | The architecture, security and contributor docs, and a reference generated from the code |

Each site publishes only the docs its manifest lists, `site/users/manifest.json`
and `site/developers/manifest.json`, so a new doc stays off both sites until
somebody decides to publish it. Nothing under `docs/user/` is published on the
developer site, and the help site publishes nothing else, so each audience sees
only what was written for it. A link from a developer doc to a user doc crosses
to the help site.

## What gets published

| Rule | Where it lives | What it does |
| --- | --- | --- |
| Allowlist | `site/<site>/manifest.json` | Lists every published doc, grouped into the sidebar's sections, in sidebar order. The help site may list `docs/user/`, or a folder inside it, as a folder; the developer site may list `docs/reference/`. Listing a folder publishes every doc under it, and no other folder can be listed |
| One home per doc | `SITES` in `site/scripts/stage-docs.js` | The help site publishes only `docs/user/`, the developer site never does, and a doc listed by both sites stops the build |
| Never publish | `NEVER_PUBLISH` in the same file | Owner decision of 2026-10-23: the deployment and production-VM guides, the runbooks and the DPA template never appear on either site. Listing one stops the build |
| No production coordinates | `FORBIDDEN_CONTENT` in the same file | A published doc that names the GCP project, the VM's host path, zone or access command, a person's `@inflect.bg` address or the production env file stops the build |
| Not deprecated | `docs/_status/doc-classification.json` | A doc classified `deprecated` is a redirect stub and is never listed |

The build enforces the first four, and
`tests/guardrails/docs-site-publication.test.ts` holds all five on every pull
request, so a doc that drifts into carrying a production coordinate fails CI
before it reaches a site.

**Exclusion is not confidentiality.** The repository is public, so every file in
`docs/` is already readable on github.com. Keeping a doc off the sites keeps it
out of their navigation and search, and stops them from becoming a second,
indexed copy of operational detail. A secret never belongs in `docs/` at all; the
secret scanner driven by `.secret-patterns` is what holds that.

## Publishing a developer doc

1. Write the doc under `docs/` and classify it in
   `docs/_status/doc-classification.json`, as every doc already must be.
2. Add its path to the right section of `site/developers/manifest.json`.
3. Run `npm test -- tests/guardrails/docs-site-publication.test.ts`. A refusal
   names the doc, the line and the coordinate it found.
4. Optionally preview it: `cd site && npm ci && npm run dev:developers`.

## Writing for the help site

Everything on the help site is written for someone using the product, not
someone building it: no source paths, permission keys, API routes or
implementation detail. Page guides live at
`docs/user/guide/<sidebar section>/<page>.md`, for example
`docs/user/guide/govern/risks.md`, and how-tos at `docs/user/how-to/`. Two rules
differ from developer docs:

- **No classification entry.** Every doc under `docs/user/` is classified
  `authoritative` by its path, the way implementation notes are `historical` by
  theirs. Adding an entry to `doc-classification.json` fails the docs-accuracy
  ratchet.
- **No manifest entry, once its folder is listed.** The help site's manifest
  lists `docs/user/guide/govern/`, so a new file in that folder is published on
  the next build. A doc a section lists by name comes first, so listing a few
  files before the folder sets their order; the folder adds the rest in path
  order.

Every page guide opens with frontmatter naming the page it documents, then uses
the same headings:

```markdown
---
route: /t/[tenantSlug]/risks
---

# {{ui:risks.title}}

One or two sentences: what the page is.

## Where to find it
## Who can use it
## What it is for
## What you see
## What you can do
## What happens next
## Empty and error states
## Related
```

**`route:`** is the page's URL pattern as `src/app/` spells it, without route
groups: `src/app/t/[tenantSlug]/(app)/risks/page.tsx` is
`/t/[tenantSlug]/risks`. The build refuses a guide whose route matches no
`page.tsx`, so removing a page shows up in the pull request that removed it. The
route is never shown to readers. It is the only frontmatter key a doc may carry;
any other key stops the build.

**Labels are tokens.** Write `{{ui:<key>}}` wherever the guide names something
on screen, with the key from `messages/en.json`. For example, `{{ui:nav.evidence}}`
prints the sidebar's own name for the evidence page. When the app renames a
label, the guide follows on the next build. The build refuses a token whose key
does not exist, names a group of messages rather than one, or carries arguments
such as `{count}`. Tokens work in prose, headings, tables and section labels in
the manifest. They are left alone inside code, so a doc can show the syntax, as
this one does.

The route and the tokens are checked by the docs build, not by the guardrail
that runs on every pull request. A renamed label is a change to the docs, and
it must not fail an unrelated code change. The docs build runs whenever
`messages/en.json` or `src/` changes, shows red on the pull request, and is not
a required check.

## The generated developer reference

Four pages of the developer site are generated from the code on every build by
`scripts/docs-reference/generate.ts`:

| Page | Generated from |
| --- | --- |
| Roles and permissions | `getPermissionsForRole` and `getOrgPermissions`, called for every value of the `Role` and `OrgRole` enums |
| Page inventory | Every `page.tsx` under `src/app/`, placed in the sidebar section `SidebarNav.tsx` puts it in, with the help-site guide that documents it |
| Page actions | Every API call a page's own files and the product components it imports make, matched to the route it reaches and the permission that route checks |
| Refusal codes | The error classes in `src/lib/errors/types.ts`, the `DomainErrorCode` union, and every place in `src/` that raises an error with a named `reason` |

Each page in `docs/reference/` is a short introduction around a line holding
only `{{generated:<name>}}`. The generator writes the fragments to
`site/.generated/` (gitignored), and the stager puts each fragment in place of
its line. A page whose fragment is missing stops the build, so a reference page
is never published without its generated half.

The generator also reports two figures, on every run and as notices on a
GitHub run: how many pages have no help-site guide yet, and what share of API
calls the page-actions scan could match. Neither is a gate: the repo does not
fail a build on documentation coverage. A call the scan cannot match is listed
under its page with the reason, never dropped.

## How a doc becomes a page

`site/scripts/stage-docs.js` copies each listed doc into its site's
`site/<site>/src/content/docs/`, which is generated and gitignored, and
Starlight builds each site from there.

- The doc's first `# ` heading becomes the page title, with any label token in
  it resolved.
- A link to another published doc goes to its page, on whichever site carries it.
- A link to an unpublished doc keeps its words and loses the link, so a site
  never routes a reader to a page that was kept off it.
- A link to any other file in the repository goes to that file on github.com.
- A component name or placeholder written in prose, such as `<DataTable>` or
  `<slug>`, is escaped so it shows as written instead of being swallowed as HTML.
- A developer-site page's edit link opens the source file in `docs/`, never the
  staged copy. Help-site pages carry no edit link.

Each site's landing page is `site/<site>/index.md`. It links to docs by their
repository paths and goes through the same rewrite, and the build fails if it
links to a doc that is not published.

## Deployment

`.github/workflows/docs-site.yml` builds both sites on every pull request that
touches `docs/`, `site/`, `CONTRIBUTING.md`, `messages/en.json`, `src/`, the
`Role` enum or the reference generator, and deploys them to GitHub Pages on every
push to `main` that does. `npm run build` in `site/` generates the reference,
stages both sites, builds each with `astro build --root <site>`, and assembles
them: the help site at the root of `site/dist/` and the developer site under
`site/dist/developers/`. The deploy job runs only once GitHub Pages is enabled
for the repository with **GitHub Actions** as its source (Settings → Pages);
until then it reports skipped.

The sites share one Starlight project's dependencies, `site/package.json` and
its lockfile, kept apart from the application's dependency tree. Dependabot
updates them weekly. The generator runs with the application's own
dependencies, which the workflow installs first.
