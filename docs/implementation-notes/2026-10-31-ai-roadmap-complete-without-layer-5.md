# 2026-10-31 — The AI architecture roadmap is complete without Layer 5

**Commit:** see the pull request that adds this note.

## Design

The owner took D-L5-1 on 2026-10-31, replacing the 2026-10-29 instruction to
plan Layer 5 on Modal for Nemotron 3 Super:

- model usage goes through LLM API keys on `inflect-external`, to providers
  already on the sub-processor register;
- no self-hosting now: no Modal, GPU VM, NIM or vLLM deployment, and no
  `inflect-hosted` provider id;
- the plan is complete when every roadmap outside Layer 5 has reached its
  "Complete at" phase; Layer 5 is optional and comes after that, or never.

The master roadmap now defines completeness (§ What complete means) and
carries each child's "Complete at" phase in its status board. Its sequencing
ends the completeness target at wave 4, and adds a final optional section for
Layer 5. Two global rules were added. G12 (complete without Layer 5) replaces
"Layer 5 is optional by construction". G13 (open-source frameworks, models
through API keys by default) is new. `modal-inference.md` keeps its filename
for link stability and now holds the optional Layer 5 plan: take it up or not,
a NIM proof of concept on a Google Cloud GPU VM, a production local route on
vLLM, and the GPU arms the other roadmaps deferred.

## Files

| File | Role |
| --- | --- |
| `docs/ai-architecture-roadmap.md` | completeness definition, G12/G13, Layer 5 section, status board, waves, dependencies, evals, decisions |
| `docs/ai-architecture/modal-inference.md` | rewritten as the optional Layer 5 plan |
| the other child roadmaps | a "Complete at" row each; GPU arms marked optional; hosted-route wording removed |
| `inspect.md`, `langflow.md`, `nemotron-reasoning.md` | corrected for Claude engines Step 2c (#4512), which turned the Tool Runner on |

## Decisions

- **`inflect-hosted` is dropped, not parked.** It existed only to keep Modal
  apart from the route a `LOCAL_ONLY` tenant trusts. A GPU in the operator's
  own project would be the local route.
- **`LOCAL_ONLY` tenants keep no model route at completion.** That is today's
  behaviour; completeness does not change it, and the roadmap says so rather
  than implying a local model arrives.
- **NIM stays a proof-of-concept tool.** It is free under the NVIDIA
  Developer Program for development and testing; production needs an NVIDIA
  AI Enterprise licence, and it is not open source (G13).
- **tldraw is named as the one exception to G13**, because D-L2-3 chose it
  before the rule existed.
- **Inspect's Phase 2 gate was re-stated.** It assumed the Tool Runner flag
  was still false, so a record would gate the flip. Step 2c flipped it without
  a record. The gate now asks for a record behind every engine whose flag is
  true, and lands together with a passing record for Flue and the Tool Runner.
- **The dependency graph draws only edges between roadmaps.** Two edges inside
  a single roadmap (Langfuse 0-2 → 3, Agent Pay 1 → 4) were folded into labels.
  Drawn as edges, they crossed other boxes and read as cross-roadmap
  dependencies.
