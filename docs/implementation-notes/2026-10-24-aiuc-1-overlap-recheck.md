# 2026-10-24 — AIUC-1 text: an independent overlap re-check, and four rewordings

**Commit:** _(stamped post-commit)_ `fix(frameworks): reword four AIUC-1 strings that shared six-word runs with AIUC's text`

## Design

`2026-10-24-aiuc-1-framework.md` records that the AIUC-1 content ships with
"no run of six or more words in common" with AIUC's published pages, other than
the requirement titles. The author measured that while writing it; nobody had
measured it independently.

An independent check, done as part of the licensing review, compared every
string in `aiuc-1.yaml`, `aiuc-1-control-templates.json` and the twelve AIUC-1
mapping sets against 195 AIUC pages. Those pages included every requirement
page, with its statement, control activities and evidence guidance. The check
ran two passes:

- **Strict:** lower-cased and punctuation-normalised.
- **Folded:** the same, plus a fold from British to American spelling, because
  our text is British and AIUC's is American.

The strict pass largely bore the claim out. The folded pass found two phrases
that only the spelling difference had hidden from the strict pass. Both came
from AIUC's own wording:

- an A008 control activity, reused in three places in our A008 control;
- the E013 requirement statement, reused in E013's description and summary.

Two further runs came from text AIUC quotes:

- an IBM phrase, in A001's description;
- one phrase, in three ISO 42001 ⇄ AIUC-1 rationales, that follows the E013
  statement.

All four are reworded here, in both the library and the fixture. The fixture's
requirement summaries stay identical to the library descriptions.

After the change, both passes leave only these shared runs:

| Run | Why it stays |
|---|---|
| The six domain names, listed in order | They are part of the enumeration we reproduce deliberately |
| The attribution line naming AIUC | Attribution should name the publisher |
| "HttpOnly, Secure and SameSite" | The names of the cookie flags |
| A SOC 2 criterion's wording, in one rationale | AICPA's criterion name, not AIUC's text |
| A filename in a header comment | Not prose |

## Files

| File | Role |
|---|---|
| `src/data/libraries/aiuc-1.yaml` | A001 and E013 descriptions reworded |
| `prisma/fixtures/aiuc-1-control-templates.json` | The same two summaries; E013's template description; A008's description, success criteria and one task title |
| `src/data/libraries/mappings/aiuc-1-to-iso-42001.yaml`, `iso-42001-to-aiuc-1.yaml` | Three rationales in each direction |

## Decisions

- **The comparison corpus is not committed.** It is AIUC's content, so it stays
  out of the repository, and so does a hash of it. A CI check would need one or
  the other, so none is added. Whether to keep a hashed shingle set for CI is
  listed in the licensing review as a question for the owner.
- **The library version stays at 1.** The importer's skip hash covers the
  library URN, its version and the node URNs, not descriptions. So a library
  sync over a database that already holds version 1 skips the import. The new
  text still reaches every database, because AIUC-1's catalogue fixture shares
  the `AIUC-1` framework row. The catalogue seeder runs at every container start
  and writes requirement descriptions straight from the fixture summaries. It
  also updates the A008 task in place, since its sort order is unchanged and
  only its hash moves. A version bump would add one effect: a manual library
  sync would record a v1 → v2 diff naming A001 and E013 as changed, and mark
  their implemented and in-progress controls NEEDS_REVIEW, although neither
  requirement asks for anything different.
- **Tasks a tenant already installed keep the old A008 title.** An installed
  task is the tenant's own record. The catalogue never rewrites it, and this
  change does not either.
- **Five-word runs are not reworded.** There are about fifty. Most are short
  technical phrases a correct description of the same requirement would use,
  such as protocol names. A run-based check also cannot detect a paraphrase
  that follows AIUC's structure too closely. Both are questions for the
  licensing review, not for this change.
