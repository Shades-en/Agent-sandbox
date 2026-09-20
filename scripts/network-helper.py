#!/usr/bin/env python3
"""Root-owned helper inside fc. Only manages this project's network resources.

Each guest sees the same tiny subnet, isolated in a separate network namespace.
Its uplink gets a distinct address; NAT carries HTTPS/DNS out through fc.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys

STATE = Path("/run/agent-sandbox-network")
BLOCKED = "0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4"
DNS = "1.1.1.1, 8.8.8.8"
GUEST = "172.30.0.2"


def run(*args, check=True, input=None):
    return subprocess.run(args, input=input, text=True, capture_output=True, check=check)


def root_rules(uplink):
    # Touch only our own table. 'add + flush' in one transaction is idempotent.
    return f'''add table inet agent_sandbox
flush table inet agent_sandbox
add set inet agent_sandbox blocked {{ type ipv4_addr; flags interval; elements = {{ {BLOCKED} }}; }}
add chain inet agent_sandbox input {{ type filter hook input priority -20; policy accept; }}
add rule inet agent_sandbox input iifname "asv*" counter drop
add chain inet agent_sandbox forward {{ type filter hook forward priority -20; policy accept; }}
add rule inet agent_sandbox forward iifname "asv*" oifname "asv*" counter drop
add rule inet agent_sandbox forward iifname "asv*" ip daddr @blocked counter drop
add rule inet agent_sandbox forward iifname "asv*" oifname "{uplink}" ip saddr 198.18.0.0/16 tcp dport 443 counter accept
add rule inet agent_sandbox forward iifname "asv*" oifname "{uplink}" ip saddr 198.18.0.0/16 ip daddr {{ {DNS} }} udp dport 53 counter accept
add rule inet agent_sandbox forward iifname "asv*" oifname "{uplink}" ip saddr 198.18.0.0/16 ip daddr {{ {DNS} }} tcp dport 53 counter accept
add rule inet agent_sandbox forward iifname "asv*" counter drop
add rule inet agent_sandbox forward oifname "asv*" ct state established,related counter accept
add rule inet agent_sandbox forward oifname "asv*" counter drop
add chain inet agent_sandbox nat {{ type nat hook postrouting priority srcnat; policy accept; }}
add rule inet agent_sandbox nat ip saddr 198.18.0.0/16 oifname "{uplink}" masquerade
'''


def namespace_rules():
    return f'''table inet sandbox {{
 set blocked {{ type ipv4_addr; flags interval; elements = {{ {BLOCKED} }}; }}
 chain input {{ type filter hook input priority filter; policy drop; iifname "lo" accept; counter drop; }}
 chain forward {{ type filter hook forward priority filter; policy drop;
  ct state invalid drop
  iifname "tap0" ip saddr != {GUEST} counter drop
  iifname "tap0" ip daddr @blocked counter drop
  iifname "tap0" oifname "uplink0" ip saddr {GUEST} tcp dport 443 counter accept
  iifname "tap0" oifname "uplink0" ip saddr {GUEST} ip daddr {{ {DNS} }} udp dport 53 counter accept
  iifname "tap0" oifname "uplink0" ip saddr {GUEST} ip daddr {{ {DNS} }} tcp dport 53 counter accept
  iifname "uplink0" oifname "tap0" ip daddr {GUEST} ct state established,related counter accept
  counter drop
 }}
 chain nat {{ type nat hook postrouting priority srcnat; policy accept;
  ip saddr {GUEST} oifname "uplink0" masquerade
 }}
}}
'''


def setup():
    routes = json.loads(run("ip", "-j", "route", "show", "default").stdout)
    uplink = routes[0]["dev"]
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,15}", uplink):
        raise ValueError("Unsupported uplink interface name")
    run("nft", "-f", "-", input=root_rules(uplink))
    run("sysctl", "-q", "-w", "net.ipv4.ip_forward=1")


def remove(identifier, lease):
    namespace = "as-" + identifier
    # Kill the VMM before removing its namespace. This also handles timeouts
    # and a failed launch. Resource names come only from a validated ID.
    for pid in run("ip", "netns", "pids", namespace, check=False).stdout.split():
        try:
            os.kill(int(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    run("ip", "netns", "del", namespace, check=False)
    run("ip", "link", "del", "asv" + identifier, check=False)
    if lease:
        run("conntrack", "-D", "-s", lease["ip"], check=False)
    (STATE / identifier).unlink(missing_ok=True)


def create(identifier, uid):
    run("nft", "list", "table", "inet", "agent_sandbox")
    if Path("/proc/sys/net/ipv4/ip_forward").read_text().strip() != "1":
        raise RuntimeError("IP forwarding is disabled; run setup-network.sh")
    used = {json.loads(p.read_text())["slot"] for p in STATE.glob("????????") if p.is_file()}
    slot = next((n for n in range(256) if n not in used), None)
    if slot is None:
        raise RuntimeError("All 256 sandbox network slots are in use")
    lease = {"uid": uid, "slot": slot, "ip": f"198.18.{slot}.2"}
    (STATE / identifier).write_text(json.dumps(lease))
    ns, veth = "as-" + identifier, "asv" + identifier
    ip = lambda *args: run("ip", "-n", ns, *args)
    try:
        run("ip", "netns", "add", ns)
        run("ip", "link", "add", veth, "type", "veth", "peer", "name", "uplink0", "netns", ns)
        run("ip", "addr", "add", f"198.18.{slot}.1/30", "dev", veth)
        run("ip", "link", "set", veth, "up")
        ip("addr", "add", f"198.18.{slot}.2/30", "dev", "uplink0")
        ip("link", "set", "uplink0", "up")
        ip("route", "add", "default", "via", f"198.18.{slot}.1")
        ip("link", "set", "lo", "up")
        run("ip", "netns", "exec", ns, "sysctl", "-q", "-w", "net.ipv4.ip_forward=1", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1")
        # Firewall is installed before the TAP can carry any guest traffic.
        run("ip", "netns", "exec", ns, "nft", "-f", "-", input=namespace_rules())
        ip("tuntap", "add", "dev", "tap0", "mode", "tap", "user", str(uid))
        ip("link", "set", "tap0", "address", "02:fc:00:00:00:02")
        ip("addr", "add", "172.30.0.1/30", "dev", "tap0")
        ip("link", "set", "tap0", "up")
    except BaseException:
        remove(identifier, lease)
        raise


def main():
    if os.geteuid() != 0:
        raise RuntimeError("This helper must run with sudo inside fc")
    if sys.argv[1:] == ["setup"]:
        setup()
        return
    if len(sys.argv) < 3 or not re.fullmatch(r"[a-f0-9]{8}", sys.argv[2]):
        raise ValueError("Expected create/delete/run and an eight-digit hexadecimal ID")
    command, identifier = sys.argv[1:3]
    uid = int(os.environ["SUDO_UID"])
    if uid == 0:
        raise ValueError("Run through sudo as the Lima user, not a root login")
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lease_path = STATE / identifier
        if command == "create":
            if lease_path.exists():
                raise ValueError("Network ID is already in use")
            create(identifier, uid)
            return
        if not lease_path.exists() and command == "delete":
            return
        lease = json.loads(lease_path.read_text())
        if lease["uid"] != uid:
            raise ValueError("Network belongs to a different user")
        if command == "delete":
            remove(identifier, lease)
            return
        if command != "run":
            raise ValueError("Unknown command")
    # Only the namespace entry needs root. Drop privileges and capabilities
    # before executing the user-owned Firecracker binary.
    account = pwd.getpwuid(uid)
    expected = str(Path(account.pw_dir) / ".sandbox/bin/firecracker")
    args = sys.argv[3:]
    if len(args) != 5 or args[0] != expected or args[1] != "--api-sock" or args[3] != "--log-path":
        raise ValueError("Unexpected Firecracker command")
    os.execvp("ip", ["ip", "netns", "exec", "as-" + identifier,
        "setpriv", "--reuid", str(uid), "--regid", str(account.pw_gid), "--init-groups",
        "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", *args])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr.strip(), file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        sys.exit(1)
