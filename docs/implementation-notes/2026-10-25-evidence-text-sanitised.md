# 2026-10-25 — Evidence free text is sanitised before it is stored

**Commit:** `<sha> fix(evidence): free text is sanitised before it is stored, and a link keeps its query string`

## Design

Evidence free text used to reach the row exactly as the caller typed it. The
owner decided it is sanitised server-side, at the usecase layer, on every write
path, so the stored row is safe for every renderer that reads it back (UI, PDF
export, audit-pack share link, API consumers), not only the ones that escape.
Rows written before this change are left as they are: no backfill, no migration.

Six writers take text from a caller and put it in an Evidence row:

| Writer | Columns from the caller |
| --- | --- |
| `evidence.createEvidence` | title, TEXT note / LINK url, category, owner, folder |
| `evidence.updateEvidence` | the same, three-state |
| `evidence.uploadEvidenceFile` | title (or the file name standing in for it), category, owner, folder. The ZIP and SharePoint imports arrive here, so they inherit it |
| `task.linkTaskEvidence`, `risk.linkRiskEvidence`, `asset.linkAssetEvidence` | the URL (content, and title when there is no note) and the note (title) |

Each column gets the profile that matches how it is read:

- **Prose** (title, a TEXT note, category, owner, folder): `sanitizePlainText`.
  A TEXT note is rendered as plain text (`whitespace-pre-wrap`, escaped by
  React) and never as HTML, so the rich-text profile has no reader to serve.
- **A URL** (a LINK row's `content`, the link writers' URL): the new
  `sanitizeUrlText`, which percent-encodes `<` `>` `"`, the backtick,
  whitespace and the controls, and parses nothing.
- **A FILE row's `content`** is the storage pathKey the upload derives. It is
  never caller text and is written exactly as derived.

A title that is blank once sanitised is refused `Title is required`, in the
usecase, on create and update. The upload falls back to the sanitised file name
(as it already did for an absent title) and the link writers fall back to the
URL (as they already did for an absent note).

## Files

| File | Role |
| --- | --- |
| `src/lib/security/sanitize.ts` | `sanitizeUrlText`, and why `sanitizePlainText` must not be used on a URL |
| `src/app-layer/usecases/evidence.ts` | create / update / upload sanitise every free-text column; blank-title refusal; an unchanged body is left alone; the update audit row records stored values |
| `src/app-layer/usecases/task.ts`, `risk.ts`, `asset.ts` | the link writers encode the URL and fall back from a blank note |
| `tests/unit/evidence-text-sanitised.test.ts` | every caller-text writer, driven with hostile input |
| `tests/unit/security/sanitize.test.ts` | `sanitizeUrlText` |
| `tests/unit/asset-usecase.test.ts` | its sanitiser mock now hands through the real URL helper |

## Decisions

- **A URL is not run through `sanitizePlainText`.** That helper parses its
  input as HTML, and an HTML parser decodes the legacy entities that need no
  closing semicolon inside text: `&reg`, `&para`, `&sect`, `&times`, `&not`,
  `&copy`, `&lt` and about a hundred more. In a URL `&` is the query separator,
  so `?lang=en&region=us` came back `?lang=en®ion=us` and `&timestamp=` came
  back `×tamp=`: a stored link that goes somewhere else. `&c=2` survives, which
  is why a spot check passes. `sanitizeUrlText` percent-encodes instead, which
  is what a browser does to those characters before it sends the request, so
  the link still points where it pointed. Nothing in the result can open a tag
  or end a double-quoted or unquoted attribute.
- **`'` and entities are left as typed in a URL.** RFC 3986 allows `'`, and
  `%27` is not strictly the same URL; an entity is text in every HTML context.
  The scheme is not judged here either: a `javascript:` link survives this as
  it survives `sanitizePlainText`. Refusing to render one is `normaliseHref`'s
  job, and the evidence detail sheet and `EvidenceSubTable` do not call it yet;
  React 19 blocks `javascript:` in `href` on its own.
- **Prose loses text in angle brackets.** `sanitizePlainText` reads `a<b, c>d`
  as a tag and returns `ad`, and a pasted XML snippet keeps only its text. That
  is the product-wide plain-text behaviour (titles, comments, findings); it now
  applies to evidence notes too.
- **The blank-title check runs in the usecase, not the schema.** The schema's
  `min(1)` cannot see that `<b></b>` is blank, and a schema refinement would
  put a second copy of the sanitiser call in a module the routes and the
  OpenAPI build share. `reviewEvidence` already checks its rejection reason the
  same way, after sanitising. A whitespace-only title, which `min(1)` accepted,
  is now refused too: it is indistinguishable from `<b> </b>` once sanitised,
  and the edit form already treated it as empty.
- **A body sent back exactly as stored is not an edit.** The edit form returns
  the body on every save. Re-sanitising it would rewrite a row written before
  this change on an edit that only moved it to a folder, and on an APPROVED row
  it would also void the approval, because the re-review check compares the
  written body with the stored one. So an unchanged body is left out of the
  write. A body that did change is sanitised, and the re-review check compares
  the SANITISED value, so markup added to an approved body that strips back to
  the approved text does not reset it. Title, category, owner and folder have
  no such consequence and are sanitised whenever they are sent.
- **The update audit row records stored values.** Its `after` block carried
  the caller's raw `title` and `category`, and an audit row streams to the
  tenant's SIEM and renders in the audit log.
- **`fileName` is not sanitised.** It mirrors `FileRecord.originalName`, which
  names the download; changing one copy would split the pair. The title, which
  is what the UI shows, is sanitised from it.
- **The system writers are unchanged.** Posture, scanner, integration, webhook,
  control-test, kill-switch drill, access-review, vendor-assessment, governance
  pack and agentic evidence all compose their text on the server, from
  constants, from records sanitised at their own write (a campaign's name, a
  test plan's name), or from an integration's answer. Some bind their body by
  digest — the agentic artefacts are verified against `sourceDigest` — so a
  rewrite here would break that verification. The ones that interpolate a
  third party's text (an integration provider's mapper, a webhook's event type)
  are the place to look if that text is ever to be sanitised too.
- **The rich-text guardrail does not cover Evidence, and was not stretched to.**
  Its population is `ENCRYPTED_FIELDS`, and `Evidence.content` is deliberately
  outside it because the list searches it. The write-path test file's coverage
  map points at the new test file instead.
- **The two vendor URLs that had the same query-string defect move too.**
  `Vendor.websiteUrl` (create and update) and a vendor document's `externalUrl`
  went through `sanitizePlainText` and now go through `sanitizeUrlText`. A
  policy's external link is not affected: its URL is `externalUrl`, which is
  stored as validated, and `sanitizePolicyContent('EXTERNAL_LINK', …)` sees
  only the version's descriptive text.
