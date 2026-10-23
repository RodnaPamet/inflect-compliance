# How this site is built

The public documentation site at
[rodnapamet.github.io/inflect-compliance](https://rodnapamet.github.io/inflect-compliance/)
is built from an allowlist of the files in `docs/`. A doc is published only when
it is listed in `site/published-docs.json`, so a new doc stays off the site until
somebody decides to publish it.

## What gets published

| Rule | Where it lives | What it does |
| --- | --- | --- |
| Allowlist | `site/published-docs.json` | Lists every published doc, grouped into the sidebar's sections, in sidebar order |
| Never publish | `NEVER_PUBLISH` in `site/scripts/stage-docs.js` | Owner decision of 2026-10-23: the deployment and production-VM guides, the runbooks and the DPA template never appear on the site. Listing one stops the build |
| No production coordinates | `FORBIDDEN_CONTENT` in the same file | A published doc that names the GCP project, the VM's host path, zone or access command, a person's `@inflect.bg` address or the production env file stops the build |
| Not deprecated | `docs/_status/doc-classification.json` | A doc classified `deprecated` is a redirect stub and is never listed |

The build enforces the first three, and
`tests/guardrails/docs-site-publication.test.ts` holds all four on every pull
request, so a doc that drifts into carrying a production coordinate fails CI
before it reaches the site.

**Exclusion is not confidentiality.** The repository is public, so every file in
`docs/` is already readable on github.com. Keeping a doc off the site keeps it out
of the site's navigation and search, and stops the site from becoming a second,
indexed copy of operational detail. A secret never belongs in `docs/` at all; the
secret scanner driven by `.secret-patterns` is what holds that.

## Publishing a doc

1. Write the doc under `docs/` and classify it in
   `docs/_status/doc-classification.json`, as every doc already must be.
2. Add its path to the right section of `site/published-docs.json`.
3. Run `npm test -- tests/guardrails/docs-site-publication.test.ts`. A refusal
   names the doc, the line and the coordinate it found.
4. Optionally preview it: `cd site && npm ci && npm run dev`.

## How a doc becomes a page

`site/scripts/stage-docs.js` copies each listed doc into
`site/src/content/docs/`, which is generated and gitignored, and Starlight builds
the site from there.

- The doc's first `# ` heading becomes the page title.
- A link to another published doc goes to its page on the site.
- A link to an unpublished doc keeps its words and loses the link, so the site
  never routes a reader to a page that was kept off it.
- A link to any other file in the repository goes to that file on github.com.
- A component name or placeholder written in prose, such as `<DataTable>` or
  `<slug>`, is escaped so it shows as written instead of being swallowed as HTML.
- Every page's edit link opens the source file in `docs/`, never the staged copy.

The landing page is `site/pages/index.md`. It links to docs by their repository
paths and goes through the same rewrite, and the build fails if it links to a doc
that is not published.

## Deployment

`.github/workflows/docs-site.yml` builds the site on every pull request that
touches `docs/`, `site/` or `CONTRIBUTING.md`, and deploys it to GitHub Pages on
every push to `main` that does. The deploy job runs only once GitHub Pages is
enabled for the repository with **GitHub Actions** as its source (Settings →
Pages); until then it reports skipped.

The site is a Starlight project with its own `site/package.json` and lockfile,
kept apart from the application's dependency tree. Dependabot updates it weekly.
