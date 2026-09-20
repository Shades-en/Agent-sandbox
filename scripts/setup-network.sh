#!/usr/bin/env bash
# Install only this project's helper and firewall service inside the Lima VM.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run inside fc: limactl shell fc -- ./scripts/setup-network.sh' >&2
  exit 1
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
sudo apt-get update
sudo apt-get install -y iproute2 nftables conntrack
sudo install -D -m 755 "$ROOT/scripts/network-helper.py" /usr/local/libexec/agent-sandbox-network
sudo tee /etc/systemd/system/agent-sandbox-network.service >/dev/null <<'UNIT'
[Unit]
Description=Outbound-only networking for agent sandbox microVMs
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/agent-sandbox-network setup
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable agent-sandbox-network.service
sudo systemctl restart agent-sandbox-network.service
echo 'ready: outbound HTTPS and public DNS; private destinations and ingress blocked'
