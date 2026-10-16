# 2026-10-08 — Normalisation library and labelled corpus (Step 3a)

**Commit:** `#3267` — "Normalisation library and labelled corpus (Step 3a)".
Pure library and fixtures: no database, no MCP, no dependency added.

> **Written after the fact.** Reconstructed on 2026-10-16 from #3267's
> description, its diff and the phases document — not from doing the work. The
> step shipped without a note, which is part of what #3234 stayed open for.

## The transliteration decision, and why it was measured first

The owner chose **in-house tables for both schemes** over promoting
`@sindresorhus/transliterate`, on a measurement rather than a preference: the
library renders **`Ъгълов` as `glov`** — it drops the hard sign entirely, and
`Ъ` appears in common Bulgarian surnames. That is not a different-but-valid
romanisation; it is data loss. It would have needed an in-house pre-pass for `Ъ`
anyway, so two tables cost less than one table plus a dependency-governance
entry plus a risk-review entry plus a pre-pass around a library that is wrong
for the primary language in scope.

The design document also claimed the library gives `Щ → Shch`, so
`Щербанов → Shcherbanov`. Measured, it gives `Scherbanov`. Worth knowing if
anyone revisits the choice.

**The two tables diverge in exactly two places**, because a second scheme is
only useful where it disagrees:

| | Streamlined (2009 law) | Traditional |
| --- | --- | --- |
| `Щербанов` | `Shterbanov` | `Shcherbanov` |
| `София` | `Sofia` (word-final `ия → ia`) | `Sofiya` |
| `Ъгълов` | `Agalov` | `Agalov` |

## Order is the whole point

Each token transliterates from its **NFC** form *before* any diacritic folding,
and the Latin result is NFD-stripped afterwards. Fold first and `й` decomposes
to `и` plus a combining breve, the breve is stripped, and the token romanises as
though it had been `и`: **`Йордан → Iordan`** and **`Николай → Nikolai`**. The
law says `Yordan` and `Nikolay`, and so does the passport in the person's hand.

Pinned, with a control asserting the breve really is what would be lost — so the
test cannot pass for a reason other than the one it names.

## Look-alike folding only on a mixed-script token

A purely Cyrillic token is transliterated and **never** folded — folding
`Иванов` gives `Иbaнob`, which is neither the name nor a romanisation of it, and
is exactly the AI Guard behaviour this subsystem refuses to inherit. A token
mixing scripts is different: `Ivаnov` with a Cyrillic `а` is a Latin name typed
through a Cyrillic keyboard, so folding recovers the intent.

## Files

| File | Role |
| --- | --- |
| `src/lib/identity/reconcile/normalise.ts` | the library (445 lines) |
| `src/lib/text/invisible-chars.ts` | extraction of zero-width and bidi characters (51) |
| `tests/fixtures/identity-reconcile/corpus.ts` | the labelled corpus (423) |
| `tests/unit/identity-reconcile-corpus.test.ts` | the corpus run (198) |
| `tests/unit/identity-reconcile-normalise.test.ts` | the library's own suite (311) |
| `tests/unit/invisible-chars-extraction.test.ts` | 98 |
| `src/app-layer/ai/guard/normalize.ts` | reuses the shared extraction |

1,533 insertions, 8 deletions.

> **Later note (2026-10-16).** `normaliseName` from this library is the LOOKUP
> side of the family-name blocker, and it takes the last token of a name at any
> count. The roster was indexed with `conventions.nameParts`, which derives a
> family name only at exactly two tokens. #3612 found that asymmetry: an account
> offering `Example` searched an index that had excluded the byte-identical
> employee. The fix gave the blocker one rule on both sides and left `nameParts`
> strict for convention generation, where a guess is a wrong link rather than
> one extra candidate.
