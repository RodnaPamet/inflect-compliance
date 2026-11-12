# 2026-11-12 — PII detector: one record format, and the in-deployment dial

**Commit:** `fix(ai/pii): one PII record format and ground truth, and the detector on the in-deployment dial`

Presidio Phase 0 (`2026-11-11-pii-redaction-decision.md`) and the Phase 1
`PiiDetector` seam (`2026-11-11-pii-detector-seam.md`) were built in parallel
and each created `src/lib/ai/pii/evaluation-record.ts`, under the same schema
id `inflect-pii-record/1`, with different shapes. This note records how they
were folded into one, and how the seam's client moved off `safeFetch` after
the owner amended G6. Where the seam's note and this one disagree, this one is
current.

## Design

```
tests/fixtures/pii/corpus.json  ──(sha256 of bytes)──►  record.corpusDigest
          │                                                   │
          ▼                                                   ▼
  scorePiiRecord(record, corpusText)  — Phase 0's rule, raw spans only
          │  perType / perTypeByLocale / perKind
          ▼
  checkPiiEvaluationRecord(record, corpusText)  — the mount condition
          │  LOW_SUPPORT (< 20 per type per locale), then
          │  BELOW_FLOOR (recall < 0.95, precision < 0.80)
          ▼
  mount.ts  — newest record for AI_PII_CONFIG_HASH by ranAt,
              detector.name === 'presidio', corpus from the working dir
          │
          ▼
  presidio-provider.ts ──► inDeploymentRequest('pii-detector', …)
```

The ground truth is Phase 0's corpus and nothing else. Phase 1's second
ground truth (`fixture-set.ts`, a canonical-JSON digest, the case kinds
positive / negative / near-miss / mixed-script, a record that copied the
expected spans beside its predictions) is deleted. What the mount gate needed
from it — per-type and per-locale recall and precision, the floors, a minimum
support — is computed from Phase 0's record and corpus.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/pii/scope.ts` | the one D-L1-1 module: types in Presidio's names, locales, routes, `LOCAL_ROUTE_REDACTED` |
| `src/lib/ai/pii/evaluation-record.ts` | Phase 0's corpus + record + scorer, plus `checkPiiEvaluationRecord`, the floors, `PII_MIN_SUPPORT`, `PII_SCORE_THRESHOLD` |
| `src/lib/ai/pii/measure.ts` | a Phase 0 record produced through any `PiiDetector` |
| `src/lib/ai/pii/mount.ts` | reads `evals/pii/records/` and `tests/fixtures/pii/corpus.json`; the only reader of `AI_PII_BASE_URL` |
| `src/lib/ai/pii/presidio-provider.ts` | the Presidio client, on the in-deployment dial |
| `src/lib/ai/in-deployment-service.ts` | registers `pii-detector` → `AI_PII_BASE_URL` |
| `guards/presidio/evaluate.py` | passes `score_threshold=0.0` explicitly |
| `tests/guards/ssrf-egress-coverage.test.ts` | the provider leaves `SINKS` and joins the in-deployment clients; `src/lib/ai/pii/` is a client directory |
| deleted: `src/lib/ai/pii/entities.ts`, `src/lib/ai/pii/fixture-set.ts` | the duplicate scope and the duplicate ground truth |

## Decisions

- **Phase 0's names win, and the translation table goes.** The seam used
  short names (`EMAIL`, `EGN`) and mapped them to Presidio's at the wire;
  Phase 0 used Presidio's names everywhere and said a translation table is
  where a type silently stops being scored. With one corpus in Presidio's
  names, keeping the short names would have put that table between the corpus
  and the detector. Placeholders become `<EMAIL_ADDRESS_1>`, `<BG_EGN_1>`.
- **Phase 0's precision rule wins.** The seam counted any overlapping
  prediction as precise; Phase 0 bounds the characters outside the gold span
  (`OVERREACH_CHARS`). The stricter rule is the one the committed record's
  figures were published with, and the gate must not judge a record on a
  looser rule than the one that describes it.
- **Support is a mount condition, not a corpus-schema condition.** Phase 0's
  corpus schema requires one span per type per locale; raising that to 20
  would make the committed corpus invalid and its record unscoreable.
  `checkPiiEvaluationRecord` refuses below 20 instead, so the committed record
  still scores (and its figures stay pinned) and is refused as `LOW_SUPPORT`
  — which is the truthful state: a held-out corpus large enough to measure a
  0.95 floor comes before any record mounts.
- **Support before floors.** A floor over a thin corpus measures nothing, so a
  record that is both thin and short is reported as thin.
- **No `scoreThreshold` in the record.** Adding a required field would break
  the committed record; an optional one read as a default is a stored claim.
  Records are produced at threshold 0 (every span, each with its score), the
  provider asks for exactly that (`PII_SCORE_THRESHOLD`), and a unit test holds
  `evaluate.py`'s value equal to it.
- **The client follows the G6 amendment.** `safeFetch` admits only public
  https addresses, so a Compose-internal `http://presidio:3000` could never
  answer; the seam had surfaced that as `BASE_URL_NOT_HTTPS`. The provider now
  dials through `inDeploymentRequest('pii-detector', …)`, the mount gate
  checks the URL's structure with `checkPerimeterUrl`
  (`BASE_URL_OUTSIDE_DEPLOYMENT`), and the fetch seam on both is removed —
  tests mock `undici` and `node:dns`. A DNS failure is `UNREACHABLE`, a public
  address or a redirect `EGRESS_REFUSED`. Every failure still throws, and the
  egress use still blocks for a tenant with redaction on.
