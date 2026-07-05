#!/usr/bin/env bash
#
# Deploy the latest committed code to the Proxmox container from your Mac.
#
# Prerequisites (one-time):
#   1. Push your changes first:            git push
#   2. SSH must reach the container. Add an entry to ~/.ssh/config, e.g.:
#
#        Host hardwork
#          HostName 192.168.1.50        # the container's IP (see notes below)
#          User root
#          IdentityFile ~/.ssh/id_ed25519
#
#      Then `ssh hardwork` should log you straight in.
#
# Usage:
#   ./deploy.sh                 # uses SSH host "hardwork"
#   HARDWORK_HOST=192.168.1.50 ./deploy.sh
#
set -euo pipefail

REMOTE="${HARDWORK_HOST:-hardwork}"   # ssh host alias or user@ip
APP_DIR="/opt/team-fitness-challenge"
SERVICE="hardwork"
BRANCH="main"

echo "🚀 Deploying to ${REMOTE} ..."

ssh "${REMOTE}" bash -s <<REMOTE_SCRIPT
set -euo pipefail
cd "${APP_DIR}"

BEFORE=\$(git rev-parse HEAD)
echo "→ Fetching origin/${BRANCH}..."
git fetch --quiet origin
git reset --hard "origin/${BRANCH}"   # force working tree to match the repo
AFTER=\$(git rev-parse HEAD)

if [ "\$BEFORE" = "\$AFTER" ]; then
  echo "→ No new commits (\${AFTER:0:7}); redeploying current code."
else
  echo "→ Updated \${BEFORE:0:7} → \${AFTER:0:7}"
fi

# Reinstall dependencies only if the package files changed.
if git diff --name-only "\$BEFORE" "\$AFTER" | grep -qE 'package(-lock)?\.json'; then
  echo "→ Dependencies changed — running npm install..."
  npm install --omit=dev
fi

chown -R hardwork:hardwork "${APP_DIR}"
echo "→ Restarting ${SERVICE}..."
systemctl restart "${SERVICE}"
sleep 1

if systemctl is-active --quiet "${SERVICE}"; then
  echo "✅ ${SERVICE} is running:  \$(git log --oneline -1)"
else
  echo "❌ ${SERVICE} failed to start. Recent logs:"
  journalctl -u "${SERVICE}" -n 20 --no-pager
  exit 1
fi
REMOTE_SCRIPT

echo "🎉 Deploy complete → https://hardwork.work"
