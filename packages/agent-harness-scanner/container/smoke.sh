#!/usr/bin/env bash
# The scanner image's smoke test (#3686): what CI runs against the image it has
# just built, and what anyone can run against one they built themselves.
#
#   packages/agent-harness-scanner/container/smoke.sh <image>
#
# Every run of the image is the way an estate is told to run it
# (README.md, Container): no network, a read-only root filesystem, every
# capability dropped, no privilege gain, as the image's own non-root user. It
# checks, in order:
#
#   1. the image runs as a user other than root, and carries no npm or npx;
#   2. `public-key` prints the raw Ed25519 public key of the key it was given;
#   3. `scan --dry-run` reads an estate of LangChain code, one Python agent and
#      one TypeScript agent, so both readers and the pinned TypeScript parser
#      run, and prints a signed report;
#   4. that report verifies against that key through the image's own contract
#      module, speaks `/2`, and holds both agents (`smoke-verify.ts`);
#   5. `scan` without `--dry-run`, with nowhere to post to, exits non-zero:
#      a scan that could not be delivered is never reported as a success.
#
# The estate is written here rather than committed: a committed `.ts` fixture
# would be type-checked and linted as this repository's own code.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
    echo "FAIL $*" >&2
    exit 1
}

# The way an estate runs the image, plus whatever a step adds.
run() {
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$@"
}

mkdir -p "$WORK/config" "$WORK/estate/support" "$WORK/estate/research"

cat > "$WORK/estate/support/agent.py" <<'PY'
import os

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI


@tool
def lookup_order(order_id: str) -> str:
    """Look an order up by its id."""
    return f"order {order_id}"


llm = ChatOpenAI(model="gpt-4o-mini", api_key=os.environ["SUPPORT_OPENAI_KEY"])
tools = [lookup_order]
prompt = ChatPromptTemplate.from_messages([("system", "You are a support agent."), ("human", "{input}")])
agent = create_tool_calling_agent(llm, tools, prompt)
support_executor = AgentExecutor(agent=agent, tools=tools)
PY

cat > "$WORK/estate/research/agent.ts" <<'TS'
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { z } from "zod";

const searchPapers = tool(async ({ query }: { query: string }) => `results for ${query}`, {
  name: "search_papers",
  description: "Search the paper index.",
  schema: z.object({ query: z.string() }),
});

const llm = new ChatAnthropic({ model: "research-model-v1", apiKey: process.env.RESEARCH_ANTHROPIC_KEY });
const prompt = ChatPromptTemplate.fromMessages([["system", "You research."], ["human", "{input}"]]);
const tools = [searchPapers];
const agent = await createToolCallingAgent({ llm, tools, prompt });
export const researchExecutor = new AgentExecutor({ agent, tools });
TS

cat > "$WORK/config/config.json" <<'JSON'
{
  "estate": "smoke",
  "scanner": { "agentId": "agt_smoke_scanner", "signingKeyEnv": "SCANNER_SIGNING_KEY" },
  "inflect": { "baseUrl": "https://inflect.invalid", "tenantSlug": "smoke", "apiKeyEnv": "INFLECT_INGEST_KEY" },
  "schedule": { "everyHours": 24 },
  "sources": [
    { "kind": "code", "product": "langchain", "roots": [{ "label": "estate", "path": "/estate" }] }
  ]
}
JSON

# The image's user is not this one: let it read what it is given, and no more.
chmod -R a+rX "$WORK"

SCANNER_SIGNING_KEY="$(openssl genpkey -algorithm ed25519)"
export SCANNER_SIGNING_KEY
# Not a key: the post it is sent with cannot leave a container with no network.
export INFLECT_INGEST_KEY=smoke-not-a-key

MOUNTS=(-v "$WORK/config:/etc/agent-harness-scanner:ro" -v "$WORK/estate:/estate:ro")

echo "== 1. the image's user and tooling"
uid="$(run --entrypoint id "$IMAGE" -u)"
[ "$uid" != "0" ] || fail "the image runs as root"
echo "ok   runs as uid $uid"
run --entrypoint sh "$IMAGE" -c '! command -v npm && ! command -v npx' || fail "the image carries npm or npx"
echo "ok   no npm, no npx"

echo "== 2. public-key"
key="$(run -e SCANNER_SIGNING_KEY "${MOUNTS[@]}" "$IMAGE" public-key --config /etc/agent-harness-scanner/config.json)"
[[ "$key" =~ ^[0-9a-f]{64}$ ]] || fail "public-key printed '$key', not a raw Ed25519 key in hex"
expected="$(printf '%s\n' "$SCANNER_SIGNING_KEY" | openssl pkey -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \n')"
[ "$key" = "$expected" ] || fail "public-key printed a key other than the one it was given"
echo "ok   $key"

echo "== 3. scan --dry-run"
run -e SCANNER_SIGNING_KEY "${MOUNTS[@]}" "$IMAGE" scan --dry-run --config /etc/agent-harness-scanner/config.json \
    > "$WORK/report.json" 2> "$WORK/scan.log" || { cat "$WORK/scan.log" >&2; fail "the dry run exited non-zero"; }
echo "ok   $(wc -c < "$WORK/report.json") bytes"

echo "== 4. the report, verified inside the image"
run -i -v "$HERE/smoke-verify.ts:/app/packages/agent-harness-scanner/container/smoke-verify.ts:ro" \
    --entrypoint node "$IMAGE" --import tsx /app/packages/agent-harness-scanner/container/smoke-verify.ts "$key" \
    < "$WORK/report.json" || fail "the report did not verify"

echo "== 5. scan with nowhere to post"
if run -e SCANNER_SIGNING_KEY -e INFLECT_INGEST_KEY "${MOUNTS[@]}" "$IMAGE" scan --config /etc/agent-harness-scanner/config.json \
    > /dev/null 2> "$WORK/post.log"; then
    fail "a scan that could not be posted exited 0"
fi
echo "ok   exited non-zero"

echo "smoke: passed"
