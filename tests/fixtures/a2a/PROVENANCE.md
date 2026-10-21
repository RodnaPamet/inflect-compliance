# `a2a-spec-v0.3.0.json`

The A2A protocol's own JSON Schema, vendored so the host-consumer agent card
(#3862) is validated against the SPEC rather than against our reading of it.

| | |
| --- | --- |
| Source | `a2aproject/A2A`, path `specification/json/a2a.json` |
| Tag | `v0.3.0` |
| Tag object sha | `210f03d426e2f2fa92000e14ef0de3b7ba15aee5` |
| **Blob sha** | `7e0da25e6f262435a000184cf0f780001d94f9c4` |
| Retrieved | 2026-10-20 |
| Bytes | 103,940 |

The blob sha is the one worth checking, because it is checkable without trusting
this note. `git hash-object tests/fixtures/a2a/a2a-spec-v0.3.0.json` prints it
locally, and

```
gh api repos/a2aproject/A2A/contents/specification/json/a2a.json?ref=v0.3.0 --jq .sha
```

prints it from upstream. They matched when this was vendored, which is what makes
"unmodified" a verified claim rather than an assurance.

Pinned by TAG, not by branch. The card declares `protocolVersion: '0.3.0'`, so
the schema it is held to must be the one that version published — a schema read
from `main` would answer about main, and would start failing or start passing
for reasons that have nothing to do with our card.

Vendored WHOLE, not trimmed to the `AgentCard` subtree. Trimming would make the
fixture our editorial selection, and a reviewer could no longer check it against
the upstream file by its sha.

To refresh at a later protocol version, fetch the new tag, record its sha here,
and expect `a2a-card-spec-conformance.test.ts` to tell you if the new schema
uses a JSON Schema keyword the validator does not implement — it pins that
vocabulary deliberately.


# `a2a-v1.0.1.proto`

The A2A protocol's **canonical** definition at tag `v1.0.1`, vendored because
the v1.0 line ships **no committed JSON Schema**.

| | |
| --- | --- |
| Source | `a2aproject/A2A`, path `specification/a2a.proto` |
| Tag | `v1.0.1` |
| Tag object sha | `3303592588e388e62e0f69f701af531d2f4e3991` |
| **Blob sha** | `400cdbad934654e27d7abbae1e145923eb40ac52` |
| Retrieved | 2026-10-21 |

## Why the proto and not a schema

At v1.0.1 `specification/json/` contains only a README, which states that
`a2a.json` is "a **non-normative build artifact** derived from the canonical
proto definition at `specification/a2a.proto`… intentionally **not** committed
to source control". Neither `specification/json/a2a.json` nor
`docs/spec/a2a.json` exists at the tag — checked, both 404.

So the v0.3 approach — vendor the JSON Schema, walk it with a generic validator
— has nothing to vendor here. Generating the JSON needs `protoc` plus
`protoc-gen-jsonschema`, which is a toolchain this repo does not have and should
not acquire for one fixture.

The proto IS the normative source, so it is what the card is checked against:
`tests/helpers/proto-messages.ts` reads message fields and their
`(google.api.field_behavior) = REQUIRED` markers out of these bytes. The
constraint still comes from upstream rather than from a transcription of it,
which is the property that mattered about the v0.3 fixture too.

Verify the same way:

```
git hash-object tests/fixtures/a2a/a2a-v1.0.1.proto
gh api repos/a2aproject/A2A/contents/specification/a2a.proto?ref=v1.0.1 --jq .sha
```
