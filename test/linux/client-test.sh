# Runs inside the client container (see run.sh): uses the packed ccusage-sync as a user would, against the SSH host
# "ccsync-host". Local logs are test/fixtures/machine-a (17218 tokens), the host's are machine-b (18887).
set -u
fails=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
tokens() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).totals.totalTokens))'; }
expect_tokens() { # label expected [args...]
  local label=$1 want=$2; shift 2
  local got; got=$(ccusage-sync claude daily --json --offline "$@" 2>/tmp/err | tokens)
  [ "$got" = "$want" ] && pass "$label: $got tokens" || fail "$label: got '$got', want $want; stderr: $(cat /tmp/err)"
}

echo "== $(uname -sm), node $(node --version), npm $(npm --version), $(rsync --version | head -1)"
npm install -g /tmp/ccusage-sync.tgz 2>&1 | grep -v -e '^$' -e 'npm notice' | tail -3
echo "== --version: $(ccusage-sync --version)"
ccusage-sync --help > /tmp/help && head -3 /tmp/help
err=$({ ccusage-sync --help | head -1 >/dev/null; } 2>&1)
[ -z "$err" ] && pass "--help into a closed pipe" || fail "--help | head -1: $err"

expect_tokens "no hosts, local logs only" 17218

out=$(ccusage-sync statusline < /dev/null 2>&1); code=$?
[ $code = 1 ] && grep -q "No input provided" <<<"$out" && pass "statusline with empty stdin fails like ccusage" || fail "statusline empty stdin: exit $code: $out"
out=$(ccusage-sync statusline < /tmp/statusline-input.json 2>&1); code=$?
[ $code = 0 ] && pass "statusline with input: $out" || fail "statusline with input: exit $code: $out"

# Trust the host key, as a user would by connecting once. Retries until sshd is up.
for _ in $(seq 20); do
  ssh-keyscan ccsync-host > ~/.ssh/known_hosts 2>/dev/null && [ -s ~/.ssh/known_hosts ] && break
  sleep 0.5
done

echo "== hosts add box me@ccsync-host"
ccusage-sync hosts add box me@ccsync-host && pass "hosts add (verified over ssh)" || fail "hosts add"

expect_tokens "report syncs and sums both machines" 36105
expect_tokens "--hosts local" 17218 --no-sync --hosts local
expect_tokens "--hosts box" 18887 --no-sync --hosts box
mirrors=$(find ~/.local/share/ccusage-sync/hosts/box -name '*.jsonl' 2>/dev/null | wc -l)
[ "$mirrors" = 2 ] && pass "mirror holds the host's 2 recent jsonl files, not the 40-day-old one" || fail "mirror has $mirrors jsonl files"

ccusage-sync sync && pass "sync" || fail "sync"
ccusage-sync hosts list

echo "== unreachable host"
ccusage-sync hosts add dead me@does-not-exist --no-verify >/dev/null
out=$(ccusage-sync claude daily --json --offline 2>&1 >/tmp/out); code=$?
got=$(tokens </tmp/out)
[ $code = 0 ] && [ "$got" = 36105 ] && pass "report still works, warning: $out" || fail "unreachable: exit $code, tokens $got, stderr: $out"

out=$(ccusage-sync hosts remove dead </dev/null)
[ "$out" = "Removed dead." ] && [ ! -e ~/.local/share/ccusage-sync/hosts/dead ] && pass "hosts remove of a never-synced host" || fail "hosts remove dead: $out"
ccusage-sync hosts remove box --purge </dev/null && pass "hosts remove --purge" || fail "hosts remove --purge"
[ ! -e ~/.local/share/ccusage-sync/hosts/box ] && pass "--purge deleted the mirror" || fail "mirror still there after --purge"
expect_tokens "back to local only" 17218

npm uninstall -g ccusage-sync >/dev/null 2>&1
hash -r
command -v ccusage-sync >/dev/null && fail "still on PATH after uninstall" || pass "npm uninstall -g"

echo "== $fails failure(s)"
exit $fails
