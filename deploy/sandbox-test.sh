#!/usr/bin/env bash
# End-to-end test of deploy/remote-deploy.sh against a throwaway copy of the
# real repository, with its own pm2 daemon (PM2_HOME), its own port and its own
# HOME — nothing on the machine it runs on is touched.
#
#   deploy/sandbox-test.sh              # needs node >= 20, git, curl; ~3 minutes
#
# Covers: cold start, reload that keeps the pm2-stored environment, status,
# the refusals (arbitrary command, bad sha, off-main commit, dirty tree, a second
# pm2 process), "never downgrade", and automatic rollback of a release that
# builds but crashes on start.

set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/generect/generect_mcp.git}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/remote-deploy.sh"
S="$(mktemp -d)"
PORT=3999
trap 'PM2_HOME=$S/pm2 "$S/tools/node_modules/.bin/pm2" kill >/dev/null 2>&1 || true; rm -rf "$S"' EXIT

pass=0 fail=0
ok()  { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }

mkdir -p "$S/tools" "$S/home"
(cd "$S/tools" && npm init -y >/dev/null && npm install --silent pm2@5 >/dev/null)
export PATH="$S/tools/node_modules/.bin:$PATH" PM2_HOME="$S/pm2"

git clone -q --bare "$REPO_URL" "$S/origin.git"
git clone -q "$S/origin.git" "$S/home/generect_mcp"
git clone -q "$S/origin.git" "$S/work"
OLD="$(git -C "$S/origin.git" rev-list --first-parent main | sed -n '5p')"   # a few merges back
# Put the script under test onto the sandbox main, so after the first deploy it
# runs from INSIDE the checkout it rewrites — exactly as on the host.
mkdir -p "$S/work/deploy" && cp "$SCRIPT" "$S/work/deploy/remote-deploy.sh"
# --allow-empty: once the script is merged, the copy is identical to what main
# already holds, and a plain commit exits 1 ("nothing to commit") under set -e —
# which failed this test on every push to main while passing on the PR.
(cd "$S/work" && git add deploy/remote-deploy.sh &&
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "script under test" && git push -q origin main)
TIP="$(git -C "$S/origin.git" rev-parse main)"
git -C "$S/home/generect_mcp" checkout -q -B main "$OLD"
# Production mode refuses to boot without real signing keys; the real host has
# them in an untracked .env, so the sandbox does too.
cat >"$S/home/generect_mcp/.env" <<ENV
JWT_SIGNING_KEY=$(openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_ENCRYPTION_SALT=$(openssl rand -hex 16)
ENV

run() {
  # The in-checkout copy once it exists (the forced-command path on the host);
  # the working-tree copy only for the very first deploy, as bootstrap does.
  local script="$S/home/generect_mcp/deploy/remote-deploy.sh"
  [ -f "$script" ] || script="$SCRIPT"
  env -i HOME="$S/home" PATH="$PATH" PM2_HOME="$PM2_HOME" NVM_DIR=/nonexistent MCP_PORT=$PORT \
    TMPDIR="$S" SSH_ORIGINAL_COMMAND="$1" bash "$script" >"$S/out" 2>&1
}
serving() { curl -s --max-time 5 "http://127.0.0.1:$PORT/" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})'; }
tip_version() { git -C "$S/origin.git" show main:package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }

echo "1. cold start (nothing running) lands on the tip"
if run deploy && [ "$(serving)" = "$(tip_version)" ]; then ok "serving $(serving)"; else bad "cold start"; cat "$S/out"; fi

echo "2. environment given to pm2 at start survives a deploy"
pm2 delete generect-mcp >/dev/null
git -C "$S/home/generect_mcp" checkout -q -B main "$OLD"
(cd "$S/home/generect_mcp" && npm ci --silent --no-audit --no-fund >/dev/null && npm run build --silent >/dev/null &&
  env MCP_PORT=$PORT SANDBOX_MARKER=kept pm2 start ecosystem.config.cjs >/dev/null)
sleep 3
run deploy || true
if pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s)[0].pm2_env.SANDBOX_MARKER==="kept"?0:1))'; then ok "SANDBOX_MARKER kept"; else bad "env lost"; fi

echo "3. status changes nothing"
if run status && grep -q "serving: $(tip_version)" "$S/out"; then ok "status"; else bad "status"; cat "$S/out"; fi

echo "4. refusals"
for req in "bash -i" "deploy abc123" 'deploy $(id)'; do
  if run "$req"; then bad "accepted: $req"; else ok "refused: $req"; fi
done
(cd "$S/work" && git checkout -q -b rogue origin/main && echo x >ROGUE && git add ROGUE &&
  git -c user.email=t@t -c user.name=t commit -qm rogue && git push -q origin rogue)
ROGUE="$(git -C "$S/work" rev-parse HEAD)"
if run "deploy $ROGUE"; then bad "accepted off-main commit"; else ok "refused off-main commit"; fi
echo "// hand edit" >>"$S/home/generect_mcp/README.md"
if run deploy; then bad "deployed over a dirty tree"; else ok "refused dirty tree"; fi
git -C "$S/home/generect_mcp" checkout -q -- README.md
(cd "$S/home/generect_mcp" && MCP_PORT=3998 pm2 start dist/http.js --name second-instance >/dev/null)
if run deploy; then bad "tolerated a second instance"; else ok "refused a second pm2 instance"; fi
pm2 delete second-instance >/dev/null

echo "5. an old sha on main never downgrades"
if run "deploy $OLD" && [ "$(serving)" = "$(tip_version)" ]; then ok "stayed on the tip"; else bad "downgraded"; cat "$S/out"; fi

echo "6. a release that builds but crashes on start is rolled back"
GOOD="$(tip_version)"
(cd "$S/work" && git checkout -q main && git pull -q &&
  sed -i "0,/^const app = express();/s//throw new Error('sandbox: simulated startup crash');\nconst app = express();/" src/http.ts &&
  node -e 'const f="package.json",p=require("./"+f);p.version+="-broken";require("fs").writeFileSync(f,JSON.stringify(p,null,2))' &&
  git -c user.email=t@t -c user.name=t commit -qam broken && git push -q origin main)
if run deploy; then bad "broken release reported success"; else
  if [ "$(serving)" = "$GOOD" ] && grep -q "rollback healthy" "$S/out"; then ok "rolled back to $GOOD"; else bad "rollback"; cat "$S/out"; fi
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
