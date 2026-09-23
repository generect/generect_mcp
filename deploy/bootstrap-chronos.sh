#!/usr/bin/env bash
# ONE-TIME setup of automated deploys on chronos. Run as root on the host:
#
#   sudo -u mcp_user git -C /home/mcp_user/generect_mcp fetch origin main
#   bash <(sudo -u mcp_user git -C /home/mcp_user/generect_mcp show origin/main:deploy/bootstrap-chronos.sh)
#
# Idempotent — safe to run again. What it does, and nothing else:
#   1. gives mcp_user back ownership of its checkout (root-owned .git shards
#      broke `git fetch` before — PRO-1168);
#   2. authorises the CI deploy key for mcp_user, locked to deploy/remote-deploy.sh
#      (`restrict` = no shell, no pty, no forwarding; `command=` = that script only);
#   3. checks sshd will accept a key for mcp_user;
#   4. checks this host's key is the one pinned in CI;
#   5. runs the first deploy (brings the host to the tip of main).

set -Eeuo pipefail

U=mcp_user
PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID7wYLjYVCW5bsS8jMbz5E4/iTO6veDIw85N/6J6nE9I generect_mcp-ci-deploy'
PINNED_HOSTKEY='SHA256:ml+C/0OZf+SpsOS6bSphQtmuyHNh0UL+pNdiHLRHSxM'

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
H="$(getent passwd "$U" | cut -d: -f6)"
D="$H/generect_mcp"
[ -d "$D/.git" ] || { echo "no checkout at $D"; exit 1; }

echo "1/5 ownership of $D"
chown -R "$U:$U" "$D"

echo "2/5 deploy key for $U"
install -d -m 700 -o "$U" -g "$U" "$H/.ssh"
AK="$H/.ssh/authorized_keys"
touch "$AK" && chown "$U:$U" "$AK" && chmod 600 "$AK"
KEYBODY="$(awk '{print $2}' <<<"$PUBKEY")"
if grep -qF "$KEYBODY" "$AK"; then
  echo "    already present"
else
  printf 'restrict,command="%s" %s\n' "$D/deploy/remote-deploy.sh" "$PUBKEY" >>"$AK"
  echo "    added (forced command: $D/deploy/remote-deploy.sh)"
fi

echo "3/5 sshd accepts keys for $U"
CFG="$(sshd -T -C user="$U",host=github-actions,addr=0.0.0.0 2>/dev/null || sshd -T 2>/dev/null)"
grep -qi '^pubkeyauthentication yes' <<<"$CFG" && echo "    pubkeyauthentication yes" || echo "    WARNING: pubkeyauthentication is not 'yes' for $U"
for k in allowusers allowgroups denyusers; do grep -i "^$k " <<<"$CFG" | sed 's/^/    /' || true; done

echo "4/5 host key"
FP="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
if [ "$FP" = "$PINNED_HOSTKEY" ]; then
  echo "    matches the key pinned in CI ($FP)"
else
  echo "    MISMATCH: host has $FP, CI pins $PINNED_HOSTKEY — CI deploys will be refused. Stop and investigate."
  exit 1
fi

echo "5/5 first deploy (as $U)"
sudo -u "$U" git -C "$D" fetch --quiet origin main
TMP="$(mktemp)"
sudo -u "$U" git -C "$D" show origin/main:deploy/remote-deploy.sh >"$TMP"
chown "$U" "$TMP" && chmod 700 "$TMP"
sudo -iu "$U" env SSH_ORIGINAL_COMMAND=deploy bash "$TMP"
rm -f "$TMP"

echo
echo "Done. From now on a green CI run on main deploys automatically."
echo "Serving: $(curl -fsS --max-time 5 http://127.0.0.1:3000/ | head -c 80)"
