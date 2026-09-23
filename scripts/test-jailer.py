#!/usr/bin/env python3
"""Live jailer checks; run inside fc after setup-network.sh and host build."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import secrets
import tempfile
import time
import sys
import importlib.util

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("network_checks", Path(__file__).with_name("test-network.py"))
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


def root(*args):
    return subprocess.check_output(["sudo", *args], text=True).strip()


def inspect_vm(namespace):
    identifier = namespace.removeprefix("as-")
    pids = root("ip", "netns", "pids", namespace).split()
    pid = next(p for p in pids if root("cat", f"/proc/{p}/comm") == "firecracker")
    status = dict(line.split(":", 1) for line in root("cat", f"/proc/{pid}/status").splitlines() if ":" in line)
    uid = int(status["Uid"].split()[0])
    assert 60000 <= uid <= 60255, status["Uid"]
    assert set(status["Uid"].split()) == {str(uid)}, status["Uid"]
    assert int(status["CapEff"].strip(), 16) == 0, "VMM retained capabilities"
    threads = json.loads(root("python3", "-c", 'import json, pathlib, sys; print(json.dumps([p.read_text() for p in pathlib.Path("/proc/"+sys.argv[1]+"/task").glob("*/status")]))', pid))
    active = [dict(line.split(":", 1) for line in text.splitlines() if ":" in line) for text in threads]
    # Filters are installed during VM initialization, not at process spawn.
    # Inspect the VMM, API and vCPU threads after the guest has started.
    if not any(t["Name"].strip().startswith("fc_vcpu") for t in active):
        raise StopIteration("Guest is still starting")
    filtered = [t for t in active if t["Name"].strip() == "firecracker" or t["Name"].strip().startswith(("fc_api", "fc_vmm", "fc_vcpu"))]
    assert len(filtered) >= 3, [(t["Name"], t["Seccomp"]) for t in active]
    assert all(t["Seccomp"].strip() == "2" for t in filtered), [(t["Name"], t["Seccomp"]) for t in filtered]
    assert status["NSpid"].split()[-1] == "1", "Missing PID namespace"
    jail = f"/srv/agent-sandbox/firecracker/{identifier}/root"
    # pivot_root can make readlink display just "/". Compare filesystem
    # identity instead of relying on that namespace-relative text.
    assert root("stat", "-Lc", "%d:%i", f"/proc/{pid}/root") == root("stat", "-Lc", "%d:%i", jail), "Wrong filesystem root"
    assert subprocess.run(["sudo", "test", "-e", f"/proc/{pid}/root/etc/passwd"]).returncode != 0
    for name, expected in [("cpu.max", "100000 100000"), ("memory.max", "536870912"), ("pids.max", "64")]:
        assert root("cat", f"/sys/fs/cgroup/agent-sandbox/{identifier}/{name}") == expected
    # Snapshot state and RAM are readable, never writable, inside the jail.
    mounts = root("cat", f"/proc/{pid}/mountinfo").splitlines()
    for target in ("/snapshot/state", "/snapshot/memory"):
        assert any(line.split()[4] == target and "ro" in line.split()[5].split(",") for line in mounts), target
    return uid


def failed_launch_cleanup():
    helper = "/usr/local/libexec/agent-sandbox-network"
    identifier = secrets.token_hex(4)
    storage = Path.home() / ".sandbox/storage"
    with tempfile.TemporaryDirectory(dir=storage / "run") as directory, tempfile.TemporaryDirectory(dir=storage / "snapshots") as snapshot:
        disk = Path(directory) / "rootfs.ext4"
        disk.touch()
        subprocess.run(["sudo", helper, "create", identifier], check=True)
        try:
            # Refuse resources outside the allowed tree before entering a jail.
            rejected = subprocess.run(["sudo", helper, "run", identifier, json.dumps({"directory": "/etc", "snapshot": snapshot})], capture_output=True, text=True)
            assert rejected.returncode != 0 and "outside" in rejected.stderr, rejected.stderr
            # Fail after a private bind mount was created: no snapshot files.
            failed = subprocess.run(["sudo", helper, "run", identifier, json.dumps({"directory": directory, "snapshot": snapshot})], capture_output=True, text=True)
            assert failed.returncode != 0 and "state" in failed.stderr, failed.stderr
        finally:
            subprocess.run(["sudo", helper, "delete", identifier], check=True)
    assert "as-" + identifier not in network.namespaces()
    assert subprocess.run(["sudo", "test", "-e", f"/srv/agent-sandbox/firecracker/{identifier}"]).returncode != 0
    assert not Path(f"/sys/fs/cgroup/agent-sandbox/{identifier}").exists()
    print("failed launch cleanup and resource path validation ok")


def main():
    # Warm the cache first so this check measures restored execution only.
    assert network.execute('console.log("ready")') == "ready\n"
    before = network.namespaces()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(network.execute, 'setTimeout(()=>console.log("done"),6000)') for _ in range(2)]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            namespaces = network.namespaces() - before
            if len(namespaces) == 2:
                try:
                    uids = [inspect_vm(ns) for ns in namespaces]
                    break
                except (StopIteration, subprocess.CalledProcessError):
                    # Namespace appears before the VMM has finished starting.
                    pass
            time.sleep(0.05)
        else:
            raise AssertionError("Two jailed VMs did not become ready")
        assert len(set(uids)) == 2, "Concurrent VMMs share a UID"
        for task in tasks:
            assert task.result() == "done\n"
    assert network.namespaces() == before, "Network leaked"
    for ns in namespaces:
        identifier = ns.removeprefix("as-")
        assert subprocess.run(["sudo", "test", "-e", f"/srv/agent-sandbox/firecracker/{identifier}"]).returncode != 0, "Jail leaked"
        assert not Path(f"/sys/fs/cgroup/agent-sandbox/{identifier}").exists(), "Cgroup leaked"
    failed_launch_cleanup()
    print("jailer ok: distinct UIDs, filesystem/PID isolation, seccomp, cgroup limits, read-only snapshots, concurrent execution and cleanup")


if __name__ == "__main__":
    main()
