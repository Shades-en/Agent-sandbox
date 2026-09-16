# Agent sandbox

An Ari agent runs JavaScript inside a Firecracker microVM. Node.js executes the source. The guest has no shell and no network, so the program cannot see the Mac or the Lima VM's files.

## Three places

Your Mac runs Ari. It cannot run Firecracker.

The Lima VM named `fc` is the Firecracker host. `fc` is only that instance's name. It is the Linux machine where the `firecracker` process and `host/dist/cli.js` run. Firecracker needs `/dev/kvm` in that VM. The microVM is a separate machine that `fc` creates for each call.

The microVM is the guest. `guest/agent.py` runs there and passes the source to `node`. A program cannot see the Mac or the Lima VM's files.

## KVM

Firecracker opens `/dev/kvm` and asks the Linux kernel to create a virtual machine. This Mac has no `/dev/kvm`. Lima's `nestedVirtualization` setting, with `vmType: vz`, asks macOS to expose KVM inside the Ubuntu guest. The machine is an Apple M5, which Lima 2.1 supports.

```bash
limactl start --name=fc lima.yaml
limactl shell fc -- ls -l /dev/kvm
```

If `/dev/kvm` is missing, stop. Nested virtualization did not come up. Nothing later in this lesson can run.

`scripts/setup-host.sh` installs a udev rule that leaves `/dev/kvm` writable. A one-time `setfacl` is not enough: starting a microVM makes udev restore the stock `root:kvm` mode `0660` and drop that entry.

After a Mac reboot, `fc` is stopped and its disk is still at `~/.lima/fc`. Start it again with `limactl start fc`. Do not run `setup-host.sh` again unless you changed `guest/agent.py` or deleted the `fc` instance.

## The API socket

`scripts/setup-host.sh` downloads Firecracker v1.17.0, a guest kernel, and an Ubuntu root disk. It installs `guest/agent.py` into that disk, enables `sandbox-agent.service`, and installs Node.js on the disk. A command inside the microVM can run `node`. The guest has no network, so `npm` cannot download packages.

```bash
limactl shell fc -- ./scripts/setup-host.sh
cd host && pnpm install && pnpm build
```

`node host/dist/cli.js exec` starts `firecracker` with `--api-sock`. The socket speaks HTTP. Before the guest boots, the controller PUTs five documents, in order:

1. `/machine-config` — 1 vCPU, 256 MiB, SMT off
2. `/boot-source` — the kernel and `keep_bootcon console=ttyS0 reboot=k panic=1`
3. `/drives/rootfs` — a fresh copy of the root disk, marked as the root device
4. `/vsock` — guest context id 3, Unix socket path for the host side
5. `/actions` — `InstanceStart`

A successful PUT returns HTTP 204. The guest has no network interface.

## vsock

The guest reaches the host with a context id and a port. The host's context id is 2. This guest's context id is 3. The agent listens on port 5000.

Bytes move through a virtio ring: a shared-memory queue the guest kernel fills and Firecracker reads. Nothing is wrapped in an IP packet. The guest has no address to dial.

On the host, Firecracker exposes that device as a Unix socket. The controller connects and sends:

```text
CONNECT 5000
```

Firecracker answers:

```text
OK <port>
```

After that the socket is a byte pipe. Each message is a 4-byte big-endian length plus JSON.

```bash
limactl shell fc -- node "$PWD/host/dist/cli.js" exec --timeout 10 -- 'console.log("hello")'
```

Run that from the repo root on the Mac. `limactl shell` keeps the current directory when it is inside the home mount. The text after `--` is the JavaScript source. Expected stdout is `hello`. The wait is about 15 seconds because this slice boots a new microVM for every call.

A boot that never reaches `CONNECT` exits 1 and names `~/.sandbox/run/<id>/serial.log`. A command that exceeds the timeout prints `timeout` and exits 124. When the root disk cannot be reflinked, that notice goes to the run's `controller.log`, not the command's stderr.

`scripts/test-integration.sh` runs that check and a `process.exit(1)` check inside the Lima VM.

## Ari

The agent package lives in this repo. It depends on the Ari checkout next door. Put `OPENAI_API_KEY` in `agent/.env`. Build Ari once, then install here:

```bash
pnpm --dir ../ai/ari build
cd agent && pnpm install && pnpm build
node dist/run.js "Run console.log('hello') in the sandbox and tell me what it printed."
```

The javascript tool is `destructive`. Its `execute` function runs `limactl shell fc -- node … exec -- <source>`. The model never gets a shell on the Mac, and text in its reply is not executed. Only the tool call runs.

## What this slice leaves out

The jailer is a second binary shipped with Firecracker. It starts first, chroots the Firecracker process, drops root, and applies a cgroup. The microVM already walls the guest off from the host. The jailer walls a buggy Firecracker process off from the rest of the host. This slice runs `firecracker` directly.

A snapshot is a copy of the guest's memory and device state taken after boot. Restoring it starts the next command in milliseconds. The files are a memory image plus a state file, and the caller still supplies the root disk. This slice boots from the kernel every time.

A later slice can keep a pool of restored VMs so the Ari tool does not pay a full boot per call.
