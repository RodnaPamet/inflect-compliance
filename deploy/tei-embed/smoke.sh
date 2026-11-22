#!/usr/bin/env bash
#
# Smoke-test a tei-embed image the way production runs it.
#
#   deploy/tei-embed/smoke.sh <image-ref>
#
# Run by ci.yml's `TEI image` job on every change to deploy/tei-embed/ and by
# .github/workflows/tei-embed-image.yml before it pushes. It starts the image
# with the production limits and hardening (read-only root, every capability
# dropped, no-new-privileges, a pids limit, 2560m at 1.0 CPU), lets it fetch
# the pinned model revision from the Hugging Face Hub, and refuses unless:
#   - its own healthcheck command answers (curl must survive the upgrade);
#   - /v1/embeddings answers for the configured model with 384 dimensions;
#   - the container was not OOM-killed.
#
# The model and revision are the ones the canonical Compose file serves;
# tests/guards/tei-embed-image.test.ts holds them equal to the benchmark's
# pin. The output is names, states and counts: no embedding is printed.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref>}"
MODEL_ID="intfloat/multilingual-e5-small"
MODEL_REVISION="614241f622f53c4eeff9890bdc4f31cfecc418b3"
DIMENSIONS=384
NAME="tei-embed-smoke-$$"
PORT=18080

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$NAME-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$NAME-data" >/dev/null
docker run -d --name "$NAME" \
    --cpus 1.0 --memory 2560m --memory-swap 2560m \
    --read-only --tmpfs /tmp:size=64m \
    --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 \
    -v "$NAME-data:/data" -p "127.0.0.1:${PORT}:8080" \
    "$IMAGE" \
    --model-id "$MODEL_ID" --revision "$MODEL_REVISION" \
    --port 8080 --max-client-batch-size 64 --auto-truncate >/dev/null

healthy=0
for _ in $(seq 1 120); do
    if docker exec "$NAME" curl -fsS -o /dev/null http://127.0.0.1:8080/health 2>/dev/null; then
        healthy=1
        break
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
        break
    fi
    sleep 2
done

state=$(docker inspect -f 'running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$NAME")
if [ "$healthy" != 1 ]; then
    echo "::error::tei-embed did not become healthy ($state)"
    docker logs "$NAME" 2>&1 | tail -20
    exit 1
fi

body=$(printf '{"model":"%s","input":["query: smoke test","passage: Доставчикът уведомява администратора."]}' "$MODEL_ID")
answer=$(curl -fsS -H 'content-type: application/json' -d "$body" "http://127.0.0.1:${PORT}/v1/embeddings")
read -r served count dims < <(printf '%s' "$answer" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("model"), len(d.get("data", [])), len(d["data"][0]["embedding"]) if d.get("data") else 0)
')

if [ "$served" != "$MODEL_ID" ] || [ "$count" != 2 ] || [ "$dims" != "$DIMENSIONS" ]; then
    echo "::error::unexpected answer: model=$served vectors=$count dims=$dims"
    exit 1
fi

state=$(docker inspect -f 'running={{.State.Running}} oom={{.State.OOMKilled}}' "$NAME")
case "$state" in
    "running=true oom=false") ;;
    *) echo "::error::tei-embed did not stay up ($state)"; exit 1 ;;
esac

echo "tei-embed smoke: healthy, model=$served, vectors=$count, dims=$dims, $state"
