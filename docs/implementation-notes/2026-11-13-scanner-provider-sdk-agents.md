# 2026-11-13 — The harness scanner reads agents built directly on a model provider's SDK

## Design

The `code` source recognised LangChain, LangGraph and Claude Agent SDK agents.
An estate whose agents are a loop around one model call, with no framework, had
none of them found: this repository's own tool-runner agents are built that
way, and a scan of its code reported no agent.

Owner decisions, 2026-11-13: four providers (Anthropic, OpenAI and Azure
OpenAI, Google Gemini, AWS Bedrock), in Python, JavaScript and TypeScript;
**an agent is a model call that is given tools**; on by default, with a switch.

```
files.ts      a file is parsed when it names a framework OR a provider's SDK
                (PROVIDER_SDK_MARKERS, only while the switch is on)
python.ts     ┐ each call now carries the function it is written in (`within`);
javascript.ts ┘ FileFacts gains `modules` (every module imported, whole) and
                `functions` (Python defs with their decorators)
recognize.ts  Recognizer.agents() asks provider-sdk.ts, through RecognizerSeam
provider-sdk.ts   shape + import  →  options  →  tools  →  model, client
```

A call is a candidate only when the file imports the provider's package (a
type-only import counts: the client is very often a parameter) AND the call
has one of that package's method shapes. Nothing is evaluated before both
hold, so an ordinary `.create(` records nothing. The shapes were read from the
packages' own type definitions and source, not from memory:
`@anthropic-ai/sdk` 1.8.0 and the copy in this repository's `node_modules`,
`anthropic` 2.8.0, `openai` 7.56.0 (npm) and 3.50.0 (PyPI), `@google/genai`
and `google-genai` 3.3.0, `@google/generative-ai` 0.24.1,
`google-generativeai` 0.8.6, `@aws-sdk/client-bedrock-runtime` 3.1168.0 and
botocore 1.44.2's `bedrock-runtime` service model.

Whether a call is given tools fails closed:

| The call's tools | Outcome |
|---|---|
| Written out, not empty | An agent, with those tools |
| Given, but not followable | An agent with no tool listed, and the place is `UNPARSEABLE` |
| An empty list, `None`, `null`, `undefined` | Not an agent, nothing recorded |
| Options read in full, no tools | Not an agent, nothing recorded |
| Options not readable at all | A tool loop (`toolRunner`, `tool_runner`, `runTools`) is an agent; any other method is not. `UNPARSEABLE` either way |

A provider agent is named by the function its call is written in, because
`response = client.messages.create(…)` names nothing. It raises no ladder
verdict. Its payment capabilities are its file's, as for every agent
(`code/payment.ts` is untouched).

Parsing more files makes three things matter that mattered less before, and
they are part of this change:

- **A file too large to parse is searched, not refused.** Over 1 MiB
  (`MAX_FILE_BYTES`) and up to 16 MiB (`MAX_MARKER_SCAN_BYTES`) a file is read
  only to look, as bytes, for a framework's or a provider SDK's name, and is
  never handed to a reader. None: no problem, since a smaller file that names
  none is not parsed either. One: `BYTE_CAP` at that file. Over 16 MiB it is
  not opened: `BYTE_CAP`. What is read to be searched counts towards the
  128 MiB total. A source file that starts with a UTF-16 byte-order mark is
  `UNPARSEABLE` at any size: decoded as UTF-8 it names nothing, and it was
  passed over as holding no agent.
- **A fault on one file costs that file.** Anything a reader or a recogniser
  throws, beyond the two readers' own refusals, makes that file `UNPARSEABLE`
  at its path, and the read goes on.
- **The places not read are named in the scanner's log.** `notReadOf` gives
  the source's read result the first 25 places (`MAX_NOT_READ_LOCATIONS`), the
  source's own reason first, each as the `code://…#L<n>` locator with its
  reason, and the count of them all; `scan.ts` writes one `not read` line per
  place after `source incomplete`, and the total when there are more.

The report contract (`inflect-agent-harness/4`), the declared surface and the
manifest hash are unchanged: the source performs the same file operations
(`scanner-surface.ts` declares no byte bound), and parses more of the files it
reads. The places not read live on `SourceRead` in memory and in the log;
`buildReportBody` copies a source's kind, status, reason and rows by name, so
they cannot reach the signed report.

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/src/sources/code/provider-sdk.ts` | New. The recognition: packages, method shapes, the tools rule, each provider's tool forms, the client's endpoint and credential |
| `packages/agent-harness-scanner/src/sources/code/recognize.ts` | The seam (`fail`, `dotted`, `option`, `deref`, `isNothing`, `chatModel` public; `reportable`), the framework union, the call into `provider-sdk.ts`, `recognizeAgents(…, { providerSdks })` |
| `packages/agent-harness-scanner/src/sources/code/ir.ts` | `FileFacts.modules`, `FileFacts.functions`, `within` on each call, `absent` on an opaque node |
| `packages/agent-harness-scanner/src/sources/code/javascript.ts` | Fills those in; reads the statements of a function that is itself a value |
| `packages/agent-harness-scanner/src/sources/code/python.ts` | Fills those in: block scope from indentation, defs with decorators, whole module names |
| `packages/agent-harness-scanner/src/sources/code/files.ts` | `PROVIDER_SDK_MARKERS`, `markersFor()`, `readCodeFiles`'s `markers` option; `MAX_MARKER_SCAN_BYTES`, the marker search over a large file, the byte-order-mark refusal |
| `packages/agent-harness-scanner/src/sources/langchain.ts`, `config.ts`, `scan.ts` | The `providerSdks` switch, from the configuration to the recogniser; the per-file catch-all; `notReadOf` and the `not read` log lines |
| `packages/agent-harness-scanner/src/source.ts` | `NotReadLocation`, `MAX_NOT_READ_LOCATIONS`, `SourceRead.notRead` and `notReadTotal` (log only) |
| `tests/helpers/agent-harness-provider-sdk-fixtures.ts` | Each provider's estate in both languages, the same shapes without the import, ordinary code, literal credentials |
| `tests/unit/agent-harness-scanner/provider-sdk-code-source.test.ts`, `code-readers.test.ts` | The behaviour above, and the two readers' new facts |
| `tests/unit/agent-harness-scanner/code-files.test.ts`, `langchain-code-source.test.ts` | The large-file bounds over an in-memory file system; the places named, the log lines, a secret-shaped path, a recogniser made to throw on one file |
| `packages/agent-harness-scanner/README.md`, `docs/agent-harness-scanner-onboarding.md`, `CLAUDE.md` | What is recognised, the tools rule, the switch |

## Decisions

- **The JavaScript reader fix is part of this change, and it is not behind the
  switch.** The reader never read the statements of a function that is itself
  a value: `const main = async () => { … }`, a class-property arrow, an object
  literal's method, a class expression's members. A model call almost always
  sits in one, so the recognition is useless without it. It also means a
  LangChain or Agent SDK agent defined in such a function is found where it
  was silently passed over, with the switch on or off.
- **A client built somewhere the file does not show has no endpoint and no
  credential.** A parameter or an import may point anywhere. Claiming the
  provider's default for it would be a guess; the report carries the `code://`
  locator of the call instead. The same holds for a client whose options are
  hidden behind a spread or a variable.
- **One call is one agent.** Two tool-bearing calls in one function are two
  agents, told apart by their lines. Merging them would be a rule the owner
  did not decide.
- **`boto3` and `botocore` are file markers**, beyond the package names that
  spell `bedrock`: a Python file handed a Bedrock client may never spell it.
  Every boto3 file is parsed as a result.
- **The older Gemini JavaScript `generateContent(x)` reads a non-object
  argument as a prompt.** Its signature takes a request object, text or parts,
  and a bare name is almost always the prompt; reading it as unreadable
  options would make every such call an `UNPARSEABLE` place.
- **`None` and `null` are marked on the opaque node (`absent`) and read only by
  the new module.** `tools=None` is then not an agent. The recogniser's own
  `isNothing` is left as it was; it never matched Python's `None` or
  JavaScript's `null`, and changing it would rename tools and agents in the
  frameworks' recognition.
- **Ported by hand from the standalone copy of this scanner, to this copy's
  rules.** A model's name goes through `reportableName`, as every other name
  here does, so a name with `@` in it is reported as not known. A URL is
  reported by this copy's `endpointOf`: with its path, without its query, and
  not at all when it looks like a secret. The standalone copy's origin-only
  endpoints and model-name pattern are that copy's hardening and are not part
  of this change. Its large-file marker search, per-file catch-all and
  not-read places are, in this copy's smallest form: the standalone copy also
  writes the places and a fixed sentence of detail to a local results file,
  which this copy does not have.
- **The places go to the log, and only there.** A model call that was not
  called an agent has no agent id to point at it, so without the place the
  estate's `code` source reads `INCOMPLETE` and the cause is found by reading
  the code. The log is the operator's own; the report is signed and posted, and
  its contract has no member for a place. A path is written through
  `codeLocator`, which gives a hash in place of one that is too long or has a
  secret's shape, and the logger redacts a secret-shaped field again behind it.
- **The byte-order-mark refusal applies to a file of any size.** The search of
  a large file needs it, because a name spelt in UTF-16 is not found as bytes.
  A small file had the same blind spot, so the same rule is applied to it
  rather than leaving two answers for one encoding. A tree that holds a UTF-16
  source file reads `INCOMPLETE` `UNPARSEABLE` where it read complete.
- **`SCANNER_VERSION` stays 0.13.0.** Its comment says it is raised with any
  change to what the scanner reads or reports. The Claude Agent SDK
  recognition (#4476) changed what the `code` source reports and did not raise
  it, and the version is inside the declared surface, so raising it moves the
  manifest hash of every scan. Whether a recognition change raises it is an
  owner decision.
- **A file that defines a provider agent is a file that defines an agent** for
  `code/payment.ts`'s dynamic-import rule: a module loaded by a computed name
  in it is `UNPARSEABLE`, as in any agent's file.

On a fresh clone of this repository (7,555 source files) the scanner finds one
agent, `src/lib/agentic/tool-runner/execute.ts#executeToolRunnerRun`, the call
at line 420 through which the tool-runner engine runs every agent. Its tools
and model are not known, because `params` is built by another module, and that
line is the one unresolved place: the source is `INCOMPLETE` `UNPARSEABLE`, and
the log names `code://inflect-compliance/src/lib/agentic/tool-runner/execute.ts#L420`.
With the switch off it finds none and the source is `COMPLETE`. The tree holds
one file over the per-file limit, a vendored 1.6 MiB bundle that names no
framework and no provider's SDK; before the marker search it made the source
`INCOMPLETE` `BYTE_CAP` either way.
