# Vendored OpenShell Agent Skills

Four Agent Skills copied from NVIDIA/OpenShell. They teach a **coding** agent to
drive the `openshell` CLI, author sandbox policy, and debug a gateway. They are
developer tooling: the product runtime never loads them, and no product code,
workflow, or Flue skill references them.

## The pin

| | |
| --- | --- |
| Source | https://github.com/NVIDIA/OpenShell |
| Commit | `bdb956f2cd65a635f1294fccf1d138d263bf650f` |
| Tag | `v0.1.5` (2026-10-20) |
| Upstream path | `skills/` |
| Licence | Apache License 2.0 — text in `LICENSE-Apache-2.0.txt` |
| Vendored | 2026-10-24 |

The commit is pinned deliberately. `npx skills add NVIDIA/OpenShell` fetches
whatever is on NVIDIA's main branch at that moment, which would make these
skills describe a gateway other than the `v0.1.5` one this repository pins in
phase 0. Re-pin by changing the commit above and re-running the manifest.

Upstream ships **no NOTICE file** at this commit, so there is no upstream NOTICE
content to carry over. Attribution is in this repository's `NOTICE`.

## Manifest — SHA-256 of every vendored file

`tests/guardrails/vendored-openshell-skills.test.ts` recomputes these offline
and fails if any file drifts, so a local edit to vendor text turns CI red.

| SHA-256 | Bytes | File |
| --- | --- | --- |
| `58503cbebb6dae8d4856224d4d570b50f2c0163564321c8bf15c946c9036b47f` | 7524 | `debug-inference/SKILL.md` |
| `b9b668c690ce900b55ea6e293b4a2aa1daa604c845fe0e6bf3b4a8a6ff686af4` | 96661 | `debug-openshell-cluster/SKILL.md` |
| `13269567408193a0c3de7bbbefab5db76506a4e7e4552c01fc359d2de1bc3622` | 8124 | `debug-openshell-cluster/references/supervisor-middleware.md` |
| `737036a0c7efcd941acbc9746dbcd3e574b055930af9b5325d235d1937c5c6cf` | 36746 | `generate-sandbox-policy/SKILL.md` |
| `60a3912debe46b70f2a7ec38ae88275223db1d312f21646194d580cbc4c8dc02` | 24569 | `generate-sandbox-policy/examples.md` |
| `53593babec9a70ee49593a001e5c73f2d05aa5f6685d205a07e4da6f4678209a` | 53104 | `openshell-cli/SKILL.md` |
| `d07c0367e2861e7fe70fa1b679f879f4fa2f9138ade4457d44ecf8b2e135bb45` | 11431 | `LICENSE-Apache-2.0.txt` |

## Vendored byte-for-byte

No edits. A re-pin is therefore a clean diff against upstream rather than a
three-way merge against local changes. Every file above was additionally checked
against GitHub's own git blob SHA at the pinned commit, which verifies the
content independently of how it was downloaded.

**Local guidance goes in `OPENSHELL-LOCAL-NOTES.md`, never inside vendor text.**
That file records where this repository's standards differ from what these
skills teach — read it alongside them.
