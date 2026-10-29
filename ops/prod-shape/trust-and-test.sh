#!/bin/sh
# In the playwright container: trust the edge's CA the way each engine reads trust, wait for the
# app to serve through the edge, then run the prod-shape suite.
set -eu
root=/caddy/caddy/pki/authorities/local/root.crt
i=0
until [ -f "$root" ]; do
  i=$((i + 1)); [ "$i" -gt 300 ] && { echo "no CA from the edge" >&2; exit 1; }
  sleep 0.2
done
# The system store: WebKit (and curl).
cp "$root" /usr/local/share/ca-certificates/porthole-prod-shape.crt
update-ca-certificates >/dev/null 2>&1
# Chromium: the user's NSS store.
mkdir -p "$HOME/.pki/nssdb"
[ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n porthole-prod-shape -i "$root"
# Firefox: Playwright's build reads neither the system store nor an enterprise policy (measured):
# its project overrides certificate errors instead (prod-shape/playwright.config.ts).
# The app serves frames once its health gate has seen its content domain through the edge.
i=0
until curl -fsS https://app.test/api/meta 2>/dev/null | grep -q '"served":true'; do
  i=$((i + 1)); [ "$i" -gt 300 ] && { echo "the app never served content through the edge" >&2; curl -sS https://app.test/api/meta >&2 || true; exit 1; }
  sleep 0.2
done
# Node (the test runner's own requests, as an app's backend makes them) trusts it too.
export NODE_EXTRA_CA_CERTS="$root"
cd /repo/packages/porthole
set -- -c prod-shape/playwright.config.ts
[ -n "${PORTHOLE_PROD_GREP:-}" ] && set -- "$@" -g "$PORTHOLE_PROD_GREP"
report=/tmp/prod-shape-results.json
rm -f "$report"
status=0
node node_modules/@playwright/test/cli.js test "$@" || status=$?
# Success means the whole suite ran: a report, no run-level errors, at least one test passed, and
# every test that was meant to run did (an interrupted run leaves tests skipped that weren't
# meant to be). run.sh requires the line this prints.
if [ "$status" -eq 0 ]; then
  node -e '
const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
let ran = 0, missed = 0;
const walk = (suite) => {
  for (const each of suite.suites ?? []) walk(each);
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests) {
      if (test.expectedStatus === "skipped") continue;
      if (test.status === "expected" || test.status === "flaky") ran++;
      else missed++;
    }
};
for (const suite of report.suites) walk(suite);
if (report.errors.length || missed || !ran) {
  console.error(`prod-shape: the suite did not run to completion (${ran} ran, ${missed} did not, ${report.errors.length} run errors)`);
  process.exit(1);
}
console.log(`prod-shape: the suite ran to completion (${ran} tests)`);
' "$report" || status=1
fi
# What the suite measured (engine differences, same-site facts), for the record.
node -e '
const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const walk = (suite) => {
  for (const each of suite.suites ?? []) walk(each);
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests)
      for (const result of test.results)
        for (const note of [...(result.annotations ?? []), ...(test.annotations ?? [])])
          if (note.type === "measured") console.log(`measured [${test.projectName}] ${spec.title.split(":")[0]}: ${note.description}`);
};
for (const suite of report.suites) walk(suite);
' "$report" 2>/dev/null | sort -u || true
exit "$status"
