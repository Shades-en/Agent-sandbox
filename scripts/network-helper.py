#!/usr/bin/env python3
"""Root-owned helper inside fc. Manages this project's network and jail resources.

Each guest sees the same tiny subnet, isolated in a separate network namespace.
Its uplink gets a distinct address; NAT carries HTTPS/DNS out through fc.
"""
import fcntl
import json
import os
from pathlib import Path
import pwd
import grp
import re
import signal
import shutil
import time
import subprocess
import sys

STATE = Path("/run/agent-sandbox-network")
BIN = Path("/usr/local/lib/agent-sandbox")
JAILS = Path("/srv/agent-sandbox")
CGROUP = Path("/sys/fs/cgroup/agent-sandbox")
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
    # Enable the controllers used by the jailer. The parent stays process-free.
    for parent in (Path("/sys/fs/cgroup"), CGROUP):
        parent.mkdir(exist_ok=True)
        (parent / "cgroup.subtree_control").write_text("+cpu +memory +pids")
    JAILS.mkdir(mode=0o700, exist_ok=True)
    # These numeric IDs are reserved for active VMs, not login accounts.
    for number in range(60000, 60256):
        for lookup in (pwd.getpwuid, grp.getgrgid):
            try:
                lookup(number)
            except KeyError:
                continue
            raise RuntimeError(f"UID/GID {number} is already assigned; reserve 60000..60255 for sandbox VMs")


def remove(identifier, lease):
    namespace = "as-" + identifier
    # Kill the VMM before removing its namespace. This also handles timeouts
    # and a failed launch. Resource names come only from a validated ID.
    for pid in run("ip", "netns", "pids", namespace, check=False).stdout.split():
        try:
            os.kill(int(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    group = CGROUP / identifier
    if (group / "cgroup.kill").exists():
        (group / "cgroup.kill").write_text("1")
    # Wait for the kernel to release the jailed process's mounts and cgroup.
    for _ in range(100):
        if not group.exists() or "populated 1" not in (group / "cgroup.events").read_text():
            break
        time.sleep(0.01)
    if group.exists():
        group.rmdir()
    jail = JAILS / "firecracker" / identifier
    if jail.exists():
        shutil.rmtree(jail)
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
        ip("tuntap", "add", "dev", "tap0", "mode", "tap", "user", str(60000 + slot))
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
    if command == "access":
        # Firecracker creates sockets as 0755, so inherited ACLs alone cannot
        # grant the separate controller UID permission to connect.
        if sys.argv[3:] not in (["api"], ["vsock"]):
            raise ValueError("Expected api or vsock")
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            lease = json.loads((STATE / identifier).read_text())
            if lease["uid"] != uid:
                raise ValueError("Network belongs to a different user")
            if "directory" in lease:
                socket = Path(lease["directory"]) / ("api.sock" if sys.argv[3] == "api" else "v.sock")
                if socket.is_socket():
                    run("setfacl", "-m", f"u:{uid}:rw", str(socket))
                    return
            time.sleep(0.03)
        raise RuntimeError("Jailed socket did not appear; inspect serial.log")
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
    launch(identifier, lease, sys.argv[3:])


def checked_path(raw, parent):
    """Accept only real paths below this user's sandbox storage, never symlinks."""
    candidate = Path(raw)
    if not candidate.is_absolute() or candidate.resolve(strict=True) != candidate:
        raise ValueError("Expected an existing absolute path without symlinks")
    if candidate.parent != parent:
        raise ValueError("Resource is outside the permitted sandbox directory")
    return candidate


def launch(identifier, lease, args):
    if len(args) != 1:
        raise ValueError("Expected one launch descriptor")
    request = json.loads(args[0])
    account = pwd.getpwuid(lease["uid"])
    storage = Path(account.pw_dir) / ".sandbox/storage"
    raw_directory = Path(request["directory"])
    building = request.get("snapshot") is None
    parent = storage / ("snapshots" if building else "run")
    directory = checked_path(str(raw_directory), parent)
    disk = checked_path(str(directory / "rootfs.ext4"), directory)
    if directory.stat().st_uid != lease["uid"]:
        raise ValueError("Run directory belongs to another user")
    snapshot = None if building else checked_path(request["snapshot"], storage / "snapshots")
    lease["directory"] = str(directory)
    pending = STATE / (identifier + ".tmp")
    pending.write_text(json.dumps(lease))
    pending.replace(STATE / identifier)
    vm_uid = 60000 + lease["slot"]
    jail = JAILS / "firecracker" / identifier / "root"
    jail.mkdir(parents=True, mode=0o700)
    # The controller retains access to sockets created by the jailed UID.
    # Only this execution's directory and disk are writable by that UID.
    run("setfacl", "-m", f"u:{vm_uid}:rwx,d:u:{lease['uid']}:rwx,d:u:{vm_uid}:rwx", str(directory))
    run("setfacl", "-m", f"u:{vm_uid}:rw", str(disk))
    # Mounts exist only in this process's namespace. Killing the VMM removes
    # them automatically; no privileged bind mounts are left on the host.
    os.unshare(os.CLONE_NEWNS)
    run("mount", "--make-rprivate", "/")

    def bind(source, name, readonly=False):
        target = jail / name
        if source.is_dir():
            target.mkdir(parents=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        run("mount", "--bind", str(source), str(target))
        if readonly:
            run("mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", str(target))

    bind(directory, "sandbox")
    if building:
        bind(BIN / "vmlinux", "kernel", readonly=True)
    else:
        for name in ("state", "memory"):
            source = checked_path(str(snapshot / name), snapshot)
            run("setfacl", "-m", f"u:{vm_uid}:r", str(source))
            bind(source, "snapshot/" + name, readonly=True)
    # Jailer adds filesystem isolation, joins the existing network namespace,
    # drops to a distinct UID, and enforces cgroup-v2 limits. Firecracker's
    # default seccomp filters remain enabled.
    command = [str(BIN / "jailer"), "--id", identifier,
        "--exec-file", str(BIN / "firecracker"), "--uid", str(vm_uid), "--gid", str(vm_uid),
        "--chroot-base-dir", str(JAILS), "--netns", "/run/netns/as-" + identifier,
        "--new-pid-ns", "--cgroup-version", "2", "--parent-cgroup", "agent-sandbox",
        "--cgroup", "cpu.max=100000 100000", "--cgroup", "memory.max=536870912",
        "--cgroup", "pids.max=64", "--resource-limit", "no-file=256",
        "--resource-limit", "fsize=2147483648",
        "--", "--api-sock", "/sandbox/api.sock", "--log-path", "/sandbox/firecracker.log"]
    os.execv(command[0], command)



if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr.strip(), file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        sys.exit(1)
