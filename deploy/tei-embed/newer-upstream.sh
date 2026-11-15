#!/usr/bin/env bash
#
# Is there an upstream TEI CPU release newer than the one the Dockerfile names?
#
#   deploy/tei-embed/newer-upstream.sh <current cpu-x.y.z> < tags.txt
#
# Reads the registry's tag list on stdin, one tag per line, and prints ONE line:
#   newer cpu-x.y.z   a release strictly newer than <current> exists
#   current           <current> is the newest cpu-x.y.z release in the list
#   incomplete        <current> is not in the list, so the list cannot be whole
#                     (the Dockerfile's FROM resolves to it) and nothing is concluded
#
# Run by .github/workflows/tei-embed-image.yml's report step; report only.
#
# WHY THIS IS A SCRIPT. The step used to take the largest release in the list
# and call it "newer" whenever it was merely DIFFERENT from <current>. GHCR
# returns at most 1,000 tags a page, in lexical order, and the step read one
# page: the list ended at cpu-1.2.1, so on 2026-11-15 it warned that cpu-1.2.1
# was newer than cpu-1.9.4. The workflow now follows every page; this script
# compares as VERSIONS (sort -V: 1.10.0 is newer than 1.9.4) and only ever
# claims "newer" for a release that sorts above <current>.
# tests/guards/tei-embed-image.test.ts runs it.
set -euo pipefail

CURRENT="${1:?usage: newer-upstream.sh <current cpu-x.y.z> < tags.txt}"
RELEASE='^cpu-[0-9]+\.[0-9]+\.[0-9]+$'
if ! [[ "$CURRENT" =~ $RELEASE ]]; then
    echo "newer-upstream.sh: '$CURRENT' is not a cpu-x.y.z release tag" >&2
    exit 2
fi

releases=$(tr -d '\r' | grep -E "$RELEASE" || true)

if ! grep -qxF -- "$CURRENT" <<<"$releases"; then
    echo incomplete
    exit 0
fi

newest=$(printf '%s\n' "$releases" | sed 's/^cpu-//' | sort -V | tail -n 1)
# <current> is in the list and `newest` is its maximum by version, so a
# different value is strictly newer. Asked again explicitly all the same: the
# larger of the two by version must be `newest` and not <current>.
larger=$(printf '%s\n%s\n' "${CURRENT#cpu-}" "$newest" | sort -V | tail -n 1)
if [ "$newest" != "${CURRENT#cpu-}" ] && [ "$larger" = "$newest" ]; then
    echo "newer cpu-${newest}"
else
    echo current
fi
