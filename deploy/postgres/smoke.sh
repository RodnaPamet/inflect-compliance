#!/usr/bin/env bash
#
# Smoke-test a postgres-pgvector image the way the stack runs it.
#
#   deploy/postgres/smoke.sh <image-ref>
#
# Run by ci.yml's `Postgres image` job on every change to deploy/postgres/ and
# by .github/workflows/postgres-pgvector-image.yml before it pushes. It starts
# the image through the upstream entrypoint (a fresh data directory, a password,
# a named database, as the Compose files do), then refuses unless:
#   - the server answers pg_isready;
#   - the C library is still musl (the existing pgdata volume's collation
#     depends on it; a Debian base would need a reindex);
#   - no compiler and no git survived the build layer;
#   - gosu (which the entrypoint drops privileges with, and su-exec links to)
#     is the one this repository rebuilt: it runs, it reports the Go version
#     of the Dockerfile's builder stage, and it switches to the postgres user;
#   - `CREATE EXTENSION vector` succeeds as the superuser and reports the
#     pinned version;
#   - a cosine nearest-neighbour query returns the expected row, once by
#     sequential scan and once through an HNSW index with iterative scans on
#     (pgvector 0.8.0+, which the backend's filtered search relies on).
#
# The output is names, versions and counts. No secret is involved: the password
# is a throwaway for a container that publishes no port and is removed on exit.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref>}"
PGVECTOR_VERSION="0.8.7"
# The Go the builder stage compiles gosu with, read from the Dockerfile beside
# this script, so the check cannot drift from the pin it checks.
DOCKERFILE="$(dirname "$0")/Dockerfile"
GO_VERSION=$(sed -n 's/^FROM golang:\([0-9][0-9.]*\)-alpine@sha256:[0-9a-f]\{64\} AS gosu-build$/go\1/p' "$DOCKERFILE")
if [ -z "$GO_VERSION" ]; then
    echo "::error::could not read the gosu builder's Go version from $DOCKERFILE"
    exit 1
fi
NAME="postgres-pgvector-smoke-$$"

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$NAME" \
    -e POSTGRES_USER=smoke -e POSTGRES_PASSWORD=smoke-only -e POSTGRES_DB=smoke \
    --memory 512m --pids-limit 256 --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
    # The entrypoint starts a temporary server for initdb and restarts it, so
    # ask twice in a row before trusting a "ready".
    if docker exec "$NAME" pg_isready -U smoke -d smoke -q 2>/dev/null \
        && sleep 1 \
        && docker exec "$NAME" pg_isready -U smoke -d smoke -q 2>/dev/null; then
        ready=1
        break
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
        break
    fi
    sleep 1
done

if [ "$ready" != 1 ]; then
    echo "::error::postgres did not become ready ($(docker inspect -f 'running={{.State.Running}} exit={{.State.ExitCode}}' "$NAME"))"
    docker logs "$NAME" 2>&1 | tail -20
    exit 1
fi

psql_q() {
    docker exec -i "$NAME" psql -U smoke -d smoke -v ON_ERROR_STOP=1 -qAt "$@"
}

# The same base, so the same C library: musl's loader names itself.
if ! docker exec "$NAME" sh -c 'ls /lib/ld-musl-*.so.1' >/dev/null 2>&1; then
    echo "::error::the image is not musl-based; the production volume's collation would change"
    exit 1
fi

# The toolchain left with its layer.
for tool in gcc cc make git; do
    if docker exec "$NAME" sh -c "command -v $tool" >/dev/null 2>&1; then
        echo "::error::$tool is present in the image; the build toolchain must be removed in the build layer"
        exit 1
    fi
done

# gosu: the rebuilt binary, not the upstream one (whose Go standard library
# carried the findings that made it necessary). `gosu --version` prints
# "<release> (<go version> on <os/arch>; gc)".
gosu_version=$(docker exec "$NAME" gosu --version 2>&1) || {
    echo "::error::gosu --version failed: $gosu_version"
    exit 1
}
case "$gosu_version" in
    *"($GO_VERSION on "*) ;;
    *) echo "::error::gosu reports '$gosu_version', expected one built with $GO_VERSION"; exit 1 ;;
esac
if [ "$(docker exec "$NAME" readlink /usr/local/bin/su-exec 2>/dev/null)" != "gosu" ]; then
    echo "::error::su-exec no longer links to gosu"
    exit 1
fi
if [ "$(docker exec "$NAME" gosu postgres id -un 2>&1)" != "postgres" ]; then
    echo "::error::gosu could not switch to the postgres user"
    exit 1
fi

version=$(psql_q -c "CREATE EXTENSION vector;" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';") || {
    echo "::error::CREATE EXTENSION vector failed: the image does not carry pgvector"
    exit 1
}
if [ "$version" != "$PGVECTOR_VERSION" ]; then
    echo "::error::CREATE EXTENSION vector gave version '$version', expected $PGVECTOR_VERSION"
    exit 1
fi

# A cosine query, first by sequential scan, then through an HNSW index with
# iterative scans on. The nearest row to [1,0,0] is 'east' in both.
answer=$(psql_q <<'SQL'
CREATE TABLE smoke_vectors (id text PRIMARY KEY, embedding vector(3) NOT NULL);
INSERT INTO smoke_vectors VALUES
    ('east', '[0.9,0.1,0]'), ('north', '[0,1,0]'), ('up', '[0,0,1]'), ('west', '[-1,0.05,0]');
SELECT id || ' ' || round((1 - (embedding <=> '[1,0,0]'))::numeric, 3)
    FROM smoke_vectors ORDER BY embedding <=> '[1,0,0]' LIMIT 1;
CREATE INDEX smoke_vectors_hnsw ON smoke_vectors USING hnsw (embedding vector_cosine_ops);
SET enable_seqscan = off;
SET hnsw.iterative_scan = strict_order;
SELECT id FROM smoke_vectors ORDER BY embedding <=> '[1,0,0]' LIMIT 1;
SELECT count(*) FROM pg_indexes WHERE indexname = 'smoke_vectors_hnsw';
SQL
) || {
    echo "::error::the cosine query failed"
    exit 1
}

expected=$'east 0.994\neast\n1'
if [ "$answer" != "$expected" ]; then
    echo "::error::unexpected cosine query answer: $(printf '%s' "$answer" | tr '\n' '|')"
    exit 1
fi

state=$(docker inspect -f 'running={{.State.Running}} oom={{.State.OOMKilled}}' "$NAME")
case "$state" in
    "running=true oom=false") ;;
    *) echo "::error::postgres did not stay up ($state)"; exit 1 ;;
esac

server=$(psql_q -c 'SHOW server_version;')
echo "postgres-pgvector smoke: server=$server, vector=$version, gosu=${gosu_version%% *} ($GO_VERSION), musl, no toolchain, cosine seq+hnsw ok, $state"
