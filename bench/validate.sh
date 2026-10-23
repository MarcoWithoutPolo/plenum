#!/usr/bin/env bash
# Check each project's hidden tests: they must pass on the reference solution and fail on the seed.
set -u
cd "$(dirname "$0")/projects"
for p in */; do
  p=${p%/}
  for side in reference seed; do
    d=$(mktemp -d)
    cp -r "$p/seed/." "$d/"
    [ "$side" = reference ] && cp -r "$p/reference/." "$d/"
    mkdir -p "$d/.hidden" && cp "$p"/hidden/* "$d/.hidden/"
    out=$(cd "$d" && node --test .hidden/*.cjs 2>&1)
    pass=$(echo "$out" | sed -n 's/^ℹ pass //p'); fail=$(echo "$out" | sed -n 's/^ℹ fail //p')
    echo "$p $side: pass=$pass fail=$fail"
    rm -rf "$d"
  done
done
