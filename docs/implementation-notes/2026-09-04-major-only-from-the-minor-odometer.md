# 2026-09-04 — the major becomes an odometer digit, and nothing else

**Commit:** `<pending>` `fix(release): make the 999 rollover the only thing that bumps the major`

Supersedes the versioning claims in
[`2026-07-16-minor-version-cap-rollover.md`](2026-07-16-minor-version-cap-rollover.md),
which is historical-by-path and left unedited. That note ends *"a real breaking
change still bumps the major the normal way, independent of the cap."* That
sentence was true when written and is what this change removes.

## Design

The odometer already existed. `scripts/lib/minor-cap.mjs::capMinor` has promoted
a `minor` release type to `major` when the last minor was already 999 since
2026-07-16. It had **never fired**. Both majors this repo has ever cut came from
a `!` commit jumping the queue:

```
a7eafef47  fix(authz)!: gate the continuity and process-map writes   1.903.12 → 2.0.0
6cb2aee09  chore(infra)!: remove the AWS estate that was never …     2.0.5    → 3.0.0
```

Major 1 ran 1502 releases over nineteen weeks. **Major 2 lasted eight hours.**

So the cap was unreachable in practice: the odometer needs ~999 minors of runway
and a breaking change could consume the whole thing at any point. The fix is one
word in `.releaserc.json` — the `breaking` releaseRule maps to `minor` instead of
`major` — after which `capMinor` is the only path to a major bump.

Expressed as **config, not code**. A demotion inside `semrel-minor-cap.mjs` would
work too, but then two places decide the release type; the wrapper stays a pure
`(baseType, lastVersion) → type` function and the rule table stays the single
seam.

## The trap: deleting the rule is not the same as setting it

The obvious implementation — drop `{breaking: true, release: "major"}` — is
wrong, silently, and asymmetrically.

`@semantic-release/commit-analyzer` v13's `index.js:57-66` consults custom
`releaseRules` first and falls back to `DEFAULT_RELEASE_RULES` **only when no
custom rule matched**. `lib/default-release-rules.js:6` is
`{breaking: true, release: "major"}`. There is no independent "notes ⇒ major"
branch anywhere in the package: `lib/analyze-commit.js:20-24` treats `breaking`
as an ordinary filter predicate over the parsed notes.

So whether a breaking commit reaches the default depends on whether some *other*
custom rule happened to match its type. Measured by execution:

| commit | `breaking → major` | `breaking → minor` | rule **deleted** |
|---|---|---|---|
| `chore(infra)!:` (the #2272 shape) | major | minor | **major** — no custom rule matches, default decides |
| `feat!:` | major | minor | minor — the `feat` rule matched |
| `fix(authz)!:` (the #2254 shape) | major | minor | **patch** — the `fix` rule matched |

Three answers by commit type, and the one that stays `major` is exactly the shape
that cut 3.0.0.

`release: false` and `release: null` are worse still: `lib/compare-release-types.js`
ranks by `RELEASE_TYPES.indexOf(...)`, and `indexOf(false)` is `-1`, which
outranks every real type inside the `.every` loop — so a `feat!` would produce
**no release at all**.

The rule must be **present and set to `minor`**.
`tests/unit/minor-cap.test.ts` asserts both halves, and the config comment says
so in capitals.

## Files

| file | role |
|---|---|
| `.releaserc.json` | the one-word change, plus a `_comment` rewritten to record the fallthrough trap |
| `scripts/lib/minor-cap.mjs` | docstring: the "a real breaking change still bumps the major" paragraph replaced; the "cosmetic" claim restated |
| `scripts/semrel-minor-cap.mjs` | docstring + the promotion log line, which claimed "no breaking change" behind a rollover |
| `tests/unit/minor-cap.test.ts` | new `describe`: four breaking shapes → `minor`, the odometer still rolls at 999, and the rule is present-and-`minor` |
| `.github/workflows/release.yml` | its header documented `BREAKING CHANGE: → major bump` |
| `docs/api-consumer-guide.md` | told external consumers a MAJOR signals a breaking change |

## Decisions

- **Why the major may be spent freely.** It has **zero machine consumers**,
  measured rather than assumed: `npmPublish: false`; `infra/helm` and its
  `sync-chart-version.mjs` were deleted on 2026-09-02 with the AWS estate; and
  the GHCR image is tagged `:latest` + `:sha-<short>` (`ghcr-publish.yml:68-70`),
  never by version. Every runtime reader — OTel `service.version`, the
  diagnostics route, openapi `info.version` — takes the whole string and parses
  no component. The old justification in the config comment ("safe because it
  only feeds Helm appVersion + Docker tags") named two consumers that had both
  already stopped existing.

- **The consumer-facing doc was the real cost, and it is why this is not purely
  cosmetic.** `docs/api-consumer-guide.md` told integrators that a MAJOR signals
  a breaking change and to regenerate their client on one. Under an odometer that
  becomes advice to regenerate on a build counter. The doc now points at
  `X-API-Version` — a **date**, bumped only for breaking changes
  (`src/lib/api-version.ts`) — which is what the compatibility contract has
  actually been all along.

- **History left alone.** 1513 tags stand. Renumbering would break every
  release reference to buy nothing; the change is entirely prospective. For the
  record, had the rule always applied the repo would be at ~**1.906.3** — the two
  `!` commits cost 902 minors of odometer travel.

- **Population: 2 commits of 3868** (0.05%) carry a breaking marker. One further
  commit mentions `BREAKING CHANGE` in prose mid-line and never matched, because
  conventional-commits-parser anchors `notesPattern` at line start.

- **Headroom.** From 3.1.3: 998 minor releases to `4.0.0`; patches are free.
  At the recent cadence (~150 minors in eight weeks) that is roughly a year; at
  major 1's average it is nearer five months.

## Adjacent, not fixed here

The release notes render **header-only** — every one of the 1514 CHANGELOG
entries carries a version heading and no sections, despite `feat`/`fix` being
`hidden: false`. `npm run release:check-notes` passes because it asserts the
notes render, not that they contain anything. Unrelated to this change and
worth its own issue.
