#!/usr/bin/env bash
# Runs the prod-shape profile (P066): the edge, DNS, the kit app and the browsers, in docker
# compose; then checks that the strict clash refuses to start. Exit status: the suite's (1 if it
# didn't say it ran to completion: trust-and-test.sh checks its report), or 1 if
# the strict clash started. Needs docker and the repository's node_modules (pnpm install).
# PORTHOLE_PROD_ENGINES=chromium (a subset), PORTHOLE_PROD_GREP=<pattern>, PORTHOLE_PROD_KEEP=1
# (leave the stack up).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
compose=(docker compose -f "$here/compose.yaml")
log=$(mktemp)
cleanup() {
  rm -f "$log"
  [ "${PORTHOLE_PROD_KEEP:-}" = 1 ] || "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT
"${compose[@]}" build --quiet playwright || exit 1
"${compose[@]}" up --abort-on-container-exit --exit-code-from playwright dns edge app clash playwright 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
# A zero exit isn't enough: the suite must say it ran to completion (trust-and-test.sh), so a run
# stopped partway, or one whose report is missing, can't pass.
if [ "$status" -eq 0 ] && ! grep -q "prod-shape: the suite ran to completion" "$log"; then
  echo "prod-shape: the suite exited 0 without running to completion" >&2
  status=1
fi
if [ "$status" -ne 0 ]; then
  "${compose[@]}" logs app clash edge | tail -60
fi
# Without the health gate, settings that can't be served must stop the app at startup.
out=$("${compose[@]}" --profile strict run --rm --no-deps clash-strict 2>&1)
code=$?
if [ "$code" -eq 0 ] || ! grep -q "ContentDomainError" <<<"$out"; then
  echo "prod-shape: the strict clash started (exit $code), or failed for another reason:" >&2
  echo "$out" | tail -20 >&2
  exit 1
fi
echo "prod-shape: the strict clash refused to start: $(grep -m1 -o 'ContentDomainError.*' <<<"$out" | cut -c1-160)"
exit "$status"
