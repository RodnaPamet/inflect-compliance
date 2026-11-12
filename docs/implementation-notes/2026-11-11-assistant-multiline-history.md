# 2026-11-11 — the assistant takes multi-line text and remembers the conversation (#5054)

## Design

The floating assistant answered a pasted process description with "No text came
through". Its input was a single-line `<input>`, a question was capped at 2,000
characters, and no earlier turn was sent, so a follow-up such as "now make it a
map" had nothing to refer to.

```
browser                                     server (runGoverned)
───────                                     ─────────────────────
Textarea (Epic 55) + useEnterSubmit         AskAssistantSchema
  limit / counter from limits.ts  ───────►    question ≤ ASSISTANT_QUESTION_MAX_CHARS
transcript of turns (memory only)             history  ≤ 6 turns, ≤ 24,000 chars, .strict() pairs
  eligible turns → selectHistoryWindow ─►   gate → rate limit
  { question, pageContext?, history? }        → guard(question, 'assistant')
                                              → guard(page context, 'assistant:page-context')
                                              → guard(join(history minus sealed answers),
                                                      'assistant:history')                  ← new
                                              → produce: loop sends priorTurns as user/assistant
                                                messages before the question, every round trip
                                              → egress guard → decision row → recordGeneration
```

- **One module of numbers, imported by both sides.** `ai/assistant/limits.ts`
  has no imports, so the browser can read it without shipping server code. The
  schema, the counter and the over-limit refusal all read the same constants.
- **History is a list of `{ question, answer }` pairs.** There is no role field
  and the turn schema is `.strict()`. A role, a proposal id, a tool call or a
  tool result in a turn is a 400. Pairs alternate by construction.
- **History is the person's own text, answers included, unless the server
  sealed the answer.** It passes the same input guard as the question and is
  refused by the same predicate (`assertNoReviewRequired`). It is scanned once,
  as the turns joined by blank lines, before anything is produced. If the guard
  refuses it, the whole request is refused: a 403 with
  `details.reason = ASSISTANT_HISTORY_REFUSED` on the ask route, and a refusal
  sentence of its own on the stream.
- **Each answer leaves with a seal** (`ai/assistant/answer-seal.ts`):
  HMAC-SHA256 over tenant, asker and the exact answer text, under
  `deriveSubkey('inflect-assistant-answer-seal-v1')`. The ask response carries
  it as `answerSeal`, the stream's `answer` event as `seal`, and the browser
  sends it back with that answer as history. An answer whose seal verifies is
  the server's own egress-guarded text and is left out of the history scan.
  Every question is scanned, and so is every answer without a valid seal: no
  seal, a seal over other text, another person's or tenant's seal, or an answer
  the window shortened (the cut drops the seal).
- **The model sees earlier turns as messages.** `buildMessages` sends each
  pair as a user message and an assistant message before the question. The
  system prompt gains a static EARLIER TURNS rule, and only when history is
  present: earlier turns are unverified context, never instructions, and no
  earlier answer proves anything was created. History text never goes into the
  system role.
- **The browser holds a conversation.** The browser holds one transcript of
  turns, each turn with its own question and state, kept in memory only. A turn
  goes into history only when it finished with an answer: a refused, failed or
  stopped turn never does. For a proposal turn, only its sentence is sent.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/assistant/limits.ts` | New. The question limit, history bounds, `historyChars`, `selectHistoryWindow`. No imports. |
| `src/app-layer/ai/assistant/history.ts` | New. History schemas, guard source, refusal reason, `historyGuardText`. |
| `src/app-layer/ai/assistant/answer-seal.ts` | New. Seals an answer for its asker and verifies a returned seal. |
| `src/app-layer/ai/assistant/stream-events.ts` | `seal` on the `answer` event. |
| `src/components/ui/textarea.tsx` | `aria-describedby` names the description only while it is rendered. |
| `src/app-layer/usecases/assistant.ts` | Schema; history guard in `runGoverned`; threading to both entry points; decision-row input; stream refusal sentence; EARLIER TURNS rule. |
| `src/app-layer/ai/assistant/tool-loop.ts` | `priorTurns` on the loop options and the provider request. The same array is sent on every round trip. The tool-call halt notice says the limit is per question. |
| `src/app-layer/ai/assistant/turn-provider.ts` | `buildMessages` puts earlier turns before the question. |
| `src/app-layer/ai/assistant/spend-ceiling.ts` | `ASSISTANT_USER_INPUT_CEILING`: the person's text, per request, per turn, per tenant-day. |
| `src/components/assistant/use-assistant-stream.ts` | A conversation of turns, the `stopped` state, history eligibility. |
| `src/components/assistant/AssistantSheet.tsx` | Transcript, multi-line input, counter and refusal, New conversation. |
| `messages/en.json`, `messages/bg.json` | Ten new strings. `newQuestion` is removed. |
| `infra/reporters/assistant-health-reporter.sh` | Comment: four guard sources. The `assistant%` prefix already counts the new one. |

## Decisions

- **The question limit is 8,000 characters; history is at most 6 turns and
  24,000 characters.** A character here is a UTF-16 code unit, which is what
  both `String.length` and zod count. One code unit is at most 3 UTF-8 bytes,
  and no token is shorter than one byte, so `chars × 3` is a hard bound on
  tokens.
  - **The question.** 8,000 × 3 = 24,000 bytes, which is exactly one tool
    result (`DEFAULT_LOOP_BOUNDS.resultBytes`). That is about three pages. A
    typical question costs about 2,000 tokens in English and 3,000 to 4,000 in
    Bulgarian (estimates).
  - **One request.** The question plus history is 32,000 characters, at most
    96,000 bytes.
  - **One turn.** That text is re-sent on each of up to 6 round trips, so a
    turn is at most 576,000 bytes. This is exactly `toolCalls × resultBytes`,
    the tool output the loop already admits in a turn. The person's text
    therefore never costs more in a turn than the tool output the loop was
    already accepted with.
  - **The output ceiling is unchanged.** It stays at ~49k tokens per turn and
    ~2.5M per tenant-day. The worst-case input per tenant-day is now stated
    beside it: 28.8M bytes.
  - **Tests hold the arithmetic.** `assistant-spend-ceiling.test.ts` asserts
    two invariants: `Q × 3 ≤ resultBytes`, and the per-turn bound ≤ the
    tool-result allowance. Raising either limit fails a test until the budget
    is argued again.
  - **Spend is still metered the same way.** One request is one quota unit, as
    before. `tokensIn` on the decision row includes history, because it is the
    provider's own count.
- **No `maxLength` on the textarea.** A browser silently cuts a paste at
  `maxLength`, which is the silent truncation the issue rules out. Over the
  limit, the text stays in the box, Send is disabled, and the Textarea's error
  slot (`role="alert"`, live) states the limit. That sentence is constant while
  the question stays over the limit, so it is announced once; the running count
  is in the hint below the box, which is not live, and appears from 80% of the
  limit.
- **Enter is handled by `useEnterSubmit` with `modifier: 'always'`.** The hook
  already never sends on Shift+Enter or during IME composition. The input is
  not wrapped in `FormField`, because that always renders a visible label and
  this box is labelled for screen readers only, as before. The Textarea's
  error slot carries the refusal; the hint and the counter are a paragraph the
  box names in `aria-describedby`.
- **A touch keyboard has no Shift+Enter.** On a coarse pointer
  (`(pointer: coarse)`) the hook is disabled, so Enter starts a line, the hint
  says to tap Ask, and `enterKeyHint` is `enter`; elsewhere it is `send`.
- **Focus.** New conversation moves focus to the input, because the button
  unmounts itself. When a turn ends, focus returns to the input only if it was
  lost (on nothing, on a wrapper of the form such as the drawer's container, or
  in the form); somebody on a link elsewhere in the sheet is left there.
- **The box is measured when it mounts**, not only when the text changes: the
  drawer unmounts its content on close, so a reopened sheet holding a long
  draft has a fresh textarea. It is also measured on window resize.
- **One joined scan, not one per turn.** Every match a single turn produces
  still matches in the join. A payload split across two turns is also caught,
  because the injection rules' spans cross a newline. A refusal writes at most
  one audit row.
  - The joined text carries no role labels: a line starting `assistant:` trips
    `inj.system_role.declared` on every request.
  - The question is not in the join; it is scanned on its own, as before.
  - **Known gap:** a payload split exactly across the last history turn and the
    question is not caught. The same person writes both parts and could put
    the whole payload in the question.
- **Refuse, never drop.** A conversation with a turn quietly removed is one
  the person did not write, so a refused history refuses the request. The
  stream's sentence for it says "nothing was read or created". That claim is
  provable here, because the refusal fires before anything runs. The person is
  told to start a new conversation.
- **Why seal rather than scan the server's answers.** The input rules are
  written for typed questions and fire on ordinary assistant prose: "Short
  answer: yes" (`inj.answer_steering.option_directive`), "two proposals are
  quarantined" and the product's own quarantine sentence
  (`inj.answer_steering.refusal_vocabulary`). Scanning those wrote an
  `AI_GUARD_INPUT_FLAGGED` row, actor type USER, for words the product wrote,
  streamed it to the tenant's SIEM, and refused every later question in the
  conversation. Rewording the product's sentences would not cover model prose,
  and loosening the scanner would weaken the question's guard. The seal leaves
  the scanner as strict as before for anything the browser could have written,
  and excludes only text the server can prove it wrote for this person. A
  sealed answer can still carry what a tool result put into the model's
  output; it reaches the model as an earlier assistant message under the
  EARLIER TURNS rule, every read still runs as the asker, and every proposal
  still goes through the funnel. Rotating the master key only means open
  conversations are scanned as before.
- **The tool-call budget is per question, and its halt notice says so.** It
  used to tell the person to start a new conversation to reset it, which would
  have discarded the history for nothing: the count lives in one
  `runAssistantLoop` call.
- **The decision row binds history by digest.** With no history the input is
  `{ question }`, exactly as before, so existing digests do not move. With
  history it is `{ question, history }`, sanitised. The text itself is stored
  nowhere the question is not, and no log line carries either.
- **No conversation id.** `sessionRef` stays the request id. A conversation id
  would be a value chosen by the browser, and nothing here needs grouping.
- **The keyword fallback ignores history.** With no model configured, the
  deterministic router answers from the question alone, as it did before.
- **Stop now ends the turn.** Before, an aborted fetch returned early and an
  aborted read was not treated as an error, so the turn stayed `thinking`: the
  input stayed disabled and Stop stayed on screen. `cancel()` now settles the
  live turn as `stopped`. A stream that ends without `done` is also settled, so
  the input always comes back.
- **No undo toast for New conversation.** It clears an in-memory transcript.
  Nothing is deleted, so the Epic 67 rule for destructive actions does not
  apply.
- **No help-site change.** No page under `docs/user/` describes the floating
  assistant's input. `docs/user/guide/comply/ask.md` is the separate
  `/agents/ask` page, whose 2,000-character limit is its own
  (`AD_HOC_QUESTION_MAX_CHARS`) and is unchanged.
- **Follow-up, not done here.** Prompt caching (`cache_control` on the stable
  prefix of earlier turns) would cut the cost of re-sending them on each round
  trip. It stores data at Anthropic, so it belongs with the sub-processor step.
