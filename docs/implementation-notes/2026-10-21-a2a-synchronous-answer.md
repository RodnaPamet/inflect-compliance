# 2026-10-21 — the synchronous A2A answer, and the sink it opens (#3863)

J3 of the SAP agent integration roadmap (#3859). Joule reads its answer out of
the `message/send` result and never calls `tasks/get`; Inflect's runs are
asynchronous jobs. This bridges the two for host consumers, and leaves peers
exactly as they were.

## The preconditions the issue demanded, confirmed

The issue opens with three facts to verify before building, and says to report
and stop if any is not what the code does. All three held:

| Fact | Where |
| --- | --- |
| `message/send` starts a run and returns its id as the task id | `a2a-inbound.ts:371` (peer), `:490` (host) |
| No wait in the handler for the run to settle | no `poll`/`waitFor`/`sleep`/`setTimeout` in the file |
| `AWAITING_APPROVAL` maps to `working`, never `input-required` | `protocol.ts:233-235`, reasoned at `:220-222` |

## STEP 3, decided AGAINST the issue's instruction

The issue asked for `AWAITING_APPROVAL` → `input-required` for host consumers.
**That is not what shipped** (owner decision, recorded on #3863).

`protocol.ts:220-222` already reasons about exactly this, and the reasoning
survives the arrival of a second principal:

> A run waiting on a person in THIS tenant is `working`, not `input-required`:
> the input it waits for is an approval the peer cannot give.

Nothing changes for a host consumer. The approval is given by a person with an
Inflect membership; neither Joule nor its user can supply it. In A2A,
`input-required` means the CLIENT must provide something — so sending it would
name the wrong actor, and a well-behaved client may then WAIT for input that
never comes instead of following up.

What serves the real need instead is the TEXT PART this issue adds anyway. A
parked run answers `working` with words that say a person inside the Inflect
workspace must approve, that nobody outside it can, and which task id to ask
again with. Words can name an actor; a state code cannot.

The same reasoning shows up in the wait itself: `awaitRunSettled` returns
**immediately** on `AWAITING_APPROVAL` or `PAUSED` rather than polling out its
budget, because waiting ten seconds in case a human approves inside them spends
the whole window to learn nothing.

## The bound, and the assumption under it

The issue said to find Joule's request timeout in SAP's toolkit **or document
the assumption**. It is not in the toolkit. Every timeout mentioned there:

| Where | Value | What it actually is |
| --- | --- | --- |
| `references/langgraph-a2a-agent.md:129,411` | `timeout=30` | the agent's OWN outbound HTTP calls |
| `scripts/scaffold.py:137` | `timeout=30` | same |
| `skills/joule-cli/SKILL.md:195` | 15 min | **deploy**, not request |
| `skills/cf-cli/SKILL.md:208` | `timeout: 120` | CF app startup |

None is Joule's timeout when calling us. The `timeout=30` figures are the only
request-scale number SAP's own code uses, so thirty seconds is taken as the
order of magnitude and the bound is **ten seconds**.

The asymmetry is why the headroom is generous rather than cautious: a wait that
runs close to the caller's limit turns a would-be `working` response into a
TIMEOUT at the caller, and Joule then has no task id to follow up with.
Overshooting loses information; undershooting costs one follow-up turn.

## STEP 2 — the sink, and a claim of mine that was wrong

I first wrote that this reader would be the FIRST reader of
`AiDecisionLog.outputSummary`. It is the **fourth**. Measured:

```
agent-harness-attribution.ts   reads  — stamps the Art 12 row's attribution
ai-decision-log.ts             reads  — the operator's view of the log
audit-workpaper-narrative.ts   reads  — captures the narrative onto a workpaper
a2a-run-answer.ts              reads  — NEW: the answer to a host consumer
```

So `flue-model-output-has-one-destination.test.ts` was never a claim about
readers. It pins where `reply.text` GOES — a tool argument, already scanned, or
one column — and it counts reads of that variable inside `execute.ts` and the
recorder. A reader in a different file was always outside its gaze, and three
already existed.

What distinguishes this one is not that it reads but that it **sends the prose
out of the organisation**. So the guard was extended to say that, rather than
either relaxed or made to count readers:

- the set of readers is PINNED, derived from the tree, so a new one is a
  reviewed diff that names the file;
- the one that crosses a boundary must be answered through an egress scan, and
  both `answer` closures in `a2a-inbound.ts` are asserted to scan — counted,
  because the host one arrived later and a third principal would arrive the
  same way;
- the reader itself is asserted NOT to scan, which guards the opposite error: a
  future edit moving the scan into the reader would leave the response path
  believing it is covered while a second caller gets nothing.

Pinning "one reader" would have failed for a reason unrelated to safety, which
is its own kind of wrong guard.

Both new assertions are mutation-proved: dropping a reader fails the exact-set
pin, and removing one `guardEgress` call fails with `scans: 2 → 1`, naming what
broke. The work was committed BEFORE mutating, because the proof restores with
`git checkout`.

## Two sources for the answer, because two engines record it differently

`driver` is a request that `selectRunDriver` intersects with what the deployment
permits, so the same workflow key settles on either engine. Flue's answer is the
model's final text on the Art 12 row, joined by `sessionRef`; a static run's is
the last SYNTHESIS step's `outputJson`. **Flue wins when both exist** — a Flue
run carries step rows too, and preferring the step would return engine
scaffolding instead of the judgement.

`WorkflowRun.summary` is NOT a third source. It is never written by anything
(#3910), and it is the obvious-looking place to read this from, which is why
the module says so out loud.

## A near-repeat of a J1 mistake

The patch adding the text part to the host's `tasks/get` matched **two** sites —
the other being the peer's, whose response bytes are covered by a receipt the
peer verifies. A match-count assertion caught it before it was written; the edit
was re-anchored on `inboundHostConsumerId`, and the peer's bare form was
verified to survive.

This is the same shape as the J1 blanket rename that broke the peer envelope.
The lesson that holds is procedural: assert the match COUNT before replacing,
because "the line I meant" and "a line that looks like it" are indistinguishable
to a string replace.

The peer contract is proved unchanged by its own suite rather than by
inspection: `a2a-peer-messaging.test.ts` verifies signed receipts over the exact
response bytes, and it passes untouched.

## Not done here

- **No wait on the follow-up turn.** `tasks/get` reads the status fresh and
  answers in the same words, but does not wait: the run has been going since the
  earlier call, so another ten seconds on a job measured in minutes buys
  nothing.
- **Peers keep polling.** Nothing in the roadmap asked otherwise, and they have
  a receipt contract over the response bytes.
- **`status.message` is absent, not `undefined`, for a peer.** Spread
  conditionally, because `undefined` and absent canonicalise differently and the
  peer's receipt is signed over the bytes.
