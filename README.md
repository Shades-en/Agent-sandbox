# Agent sandbox

An Ari agent runs JavaScript inside a Firecracker microVM. Node.js executes the source. The guest has no shell and no network, so the program cannot see the Mac or the Lima VM's files.

## Three places

Your Mac runs Ari. It cannot run Firecracker.

The Lima VM named `fc` is the Firecracker host. `fc` is only that instance's name. It is the Linux machine where the `firecracker` process and `host/dist/cli.js` run. Firecracker needs `/dev/kvm` in that VM. The microVM is a separate machine that `fc` creates for each call.

The microVM is the guest. `guest/agent.py` runs there and passes the source to a waiting Node process running `guest/runtime.cjs`. A program cannot see the Mac or the Lima VM's files.

## KVM

Firecracker opens `/dev/kvm` and asks the Linux kernel to create a virtual machine. This Mac has no `/dev/kvm`. Lima's `nestedVirtualization` setting, with `vmType: vz`, asks macOS to expose KVM inside the Ubuntu guest. The machine is an Apple M5, which Lima 2.1 supports.

```bash
limactl start --name=fc lima.yaml
limactl shell fc -- ls -l /dev/kvm
```

If `/dev/kvm` is missing, stop. Nested virtualization did not come up. Nothing later in this lesson can run.

`scripts/setup-host.sh` installs a udev rule that leaves `/dev/kvm` writable. A one-time `setfacl` is not enough: starting a microVM makes udev restore the stock `root:kvm` mode `0660` and drop that entry.

After a Mac reboot, `fc` is stopped and its disk is still at `~/.lima/fc`. Start it again with `limactl start fc`. Do not run `setup-host.sh` again unless you changed the guest code or runtime, or deleted the `fc` instance.

## The API socket

`scripts/setup-host.sh` downloads Firecracker v1.17.0, a guest kernel, and an Ubuntu root disk. It installs `guest/agent.py` into that disk, enables `sandbox-agent.service`, and installs Node.js on the disk. A command inside the microVM can run `node`. The guest has no network, so `npm` cannot download packages.

```bash
limactl shell fc -- ./scripts/setup-host.sh
cd host && pnpm install && pnpm build
```

`node host/dist/cli.js exec` starts `firecracker` with `--api-sock`. The socket speaks HTTP. To build the initial snapshot, the controller PUTs five documents, in order:

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

Run that from the repo root on the Mac. `limactl shell` keeps the current directory when it is inside the home mount. The text after `--` is the JavaScript source. Expected stdout is `hello`. The first execution builds a snapshot and pays the full boot cost. Later executions restore it automatically, using the same command.

A boot that never reaches `CONNECT` exits 1 and names `~/.sandbox/storage/run/<id>/serial.log`. A command that exceeds the timeout prints `timeout` and exits 124. A missing Btrfs mount or a refused reflink is a controller error; there is no slow full-copy fallback.

`scripts/test-integration.sh` runs that check and a `process.exit(1)` check inside the Lima VM.

## Snapshots: skip repeated boots

On the first execution, `host/src/snapshot.ts` boots a clean guest and waits for
`guest/agent.py` to write `SANDBOX_NODE_READY_FOR_SNAPSHOT` to the serial console.
Before writing that marker, the listener starts `guest/runtime.cjs`. Node loads its
runtime and registers a stdin handler, then signals that it is ready. Python
consumes that signal so it never appears in a tool result. At snapshot time,
Node is already running, port 5000 is listening, and no user code has run.
The controller then pauses the guest with `PATCH /vm` and saves a full snapshot
with `PUT /snapshot/create`.

The snapshot lives inside Lima at `~/.sandbox/storage/snapshots/<key>/`:

- `state`: virtual CPU and device state.
- `memory`: the guest RAM, loaded on demand by Firecracker.
- `rootfs.ext4`: the disk as it was when memory was saved, including boot-time writes.
- `ready`: published only after snapshot creation succeeds.

Each execution reflink-clones that saved disk into its own run directory, starts a fresh
Firecracker process, and calls `PUT /snapshot/load` with `resume_vm: false`.
It overrides the vsock path, switches the root drive to the private disk with
`PATCH /drives/rootfs`, and only then resumes with `PATCH /vm`.
Memory writes are private to that restored VM. It is destroyed after one execution;
files and processes from earlier executions do not carry over. No VM pool is used.

After restore, Python writes the JavaScript into the saved Node process's stdin
and closes the pipe. The registered handler executes the source; it does not
start another Node process. Output is captured as before, and timers and promises
keep Node alive until they finish. Source is a script with Node globals and
CommonJS `require()` for built-in modules. Static ESM imports and top-level
`await` are not supported by this script entry point; use an async function for
asynchronous code. `node:vm` executes the source in Node's own global context;
Firecracker remains the isolation boundary.

The cache key includes image and binary file metadata, machine settings, and Linux
host information. Rebuilding the root disk with `scripts/setup-host.sh` causes the
next execution to build a new snapshot automatically. Keep these snapshots local
to `fc`; do not move them between hosts. Concurrent first calls wait for one build.
If a build is forcibly interrupted and reports a leftover `.lock` directory,
check that no builder is running before removing that reported directory.

To update an existing installation for snapshot support, run these once from the repo root:

```bash
pnpm --dir host build
limactl shell fc -- ./scripts/setup-host.sh
```

Then run the JavaScript command above twice. The first call includes snapshot
creation and Node startup; later calls measure a reflink disk clone, restore,
communication, and execution in the already-running Node process.

The timeout option limits execution after the vsock connection; it does not include
building the initial snapshot. A missing readiness marker fails with a serial-log
path and a reminder to rebuild the guest image.

See [Firecracker snapshot documentation](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/snapshot-support.md)
for the API and snapshot lifecycle.

## Disk storage: cheap private clones

A filesystem decides how files are stored on disk. **ext4** is the filesystem on
`fc`'s main Linux disk. It is also the filesystem inside each guest root-disk
image. These are separate layers: a guest disk image is just a file to the host.

A **reflink** creates a new file that initially shares the original file's data
blocks. When either file changes, the filesystem gives the changed blocks their
own storage. This is copy-on-write: copying is deferred until a write actually
needs it. The files remain independent, without duplicating all the initial data.

**Btrfs** and **XFS** are Linux filesystems that support reflinks (XFS must be
formatted with reflink support). This project uses Btrfs in a dedicated image
file inside `fc`. We do not reformat the VM's existing disk or change the ext4
filesystem that the microVM boots.

`scripts/setup-storage.sh` creates and mounts this layout inside Lima:

- `~/.sandbox/storage.btrfs`: a sparse 16 GiB backing file. It consumes physical
  space as data is written, rather than reserving all 16 GiB immediately.
- `~/.sandbox/storage/`: its Btrfs mount, automatically mounted via `/etc/fstab`
  after a VM restart.
- `storage/images/rootfs.ext4`: the base guest image, imported once from the
  image built by setup. This initial import may copy bytes across filesystems.
- `storage/snapshots/<key>/`: saved memory, state, and the matching booted disk.
- `storage/run/<id>/`: a reflink clone for one execution, plus diagnostic logs.

Both the source and destination of a reflink must be on the same filesystem.
The controller uses `cp --reflink=always` for snapshot disks and execution disks;
it fails if cloning is unsupported. It also checks that the storage directory
is on Btrfs before creating any run files. If the mount is missing, run storage
setup inside `fc` instead of accepting a slow fallback.

Full host setup calls storage setup automatically. To upgrade an already-working
installation without rebuilding its guest image, run from the repository root:

```bash
limactl shell fc -- ./scripts/setup-storage.sh
pnpm --dir host build
```

The next execution builds a new snapshot on Btrfs. Old snapshots and run disks
outside `storage/` are left untouched and are no longer used. After restarting
`fc`, the volume mounts automatically and the snapshot can be reused; setup is
not required for each restart. Rerunning storage setup reuses the existing volume
and imports the guest image again only if it was rebuilt.

On the development M5/Lima host, a private disk clone measured about **3 ms**,
compared with about **657 ms** for the previous full-copy path. Three warm
`hello` calls measured **1.055, 0.914, and 0.867 seconds** end to end. Restore,
communication, and guest execution still cost time; these are local measurements.

The 16 GiB volume has a fixed logical capacity. Run directories are retained for
inspection; changed blocks and additional snapshots consume space over time.
`df -h ~/.sandbox/storage` inside `fc` reports the remaining space. Reflinks save
copy time and space; they do not give unlimited capacity.

See the [Btrfs reflink documentation](https://btrfs.readthedocs.io/en/latest/Reflink.html)
for how block sharing works.

## Ari

The agent package lives in this repo. It depends on the Ari checkout next door. Put `OPENAI_API_KEY` in `agent/.env`. Build Ari once, then install here:

```bash
pnpm --dir ../ai/ari build
cd agent && pnpm install && pnpm build
node dist/run.js "Run console.log('hello') in the sandbox and tell me what it printed."
```

The javascript tool is `destructive`. Its `execute` function runs `limactl shell fc -- node … exec -- <source>`. The model never gets a shell on the Mac, and text in its reply is not executed. Only the tool call runs.

## Conversation and timing logs

Start an interactive conversation from `agent/`:

```bash
node dist/run.js --timings
```

Or start with an initial request and then continue at `you>`:

```bash
node dist/run.js --timings "Run console.log('hello') in the sandbox and tell me what it printed."
```

The loop reuses one Ari session, so follow-up messages keep the conversation
history. `/exit`, `/quit`, or Ctrl+D ends the chat. History is held in memory
and ends when this process exits. Every tool call still gets a new sandbox:
conversation memory does not preserve guest files or JavaScript variables.
Ctrl+C requests cancellation and closes the chat.

For one request followed by exit (including scripts/benchmarks), use:

```bash
node dist/run.js --timings --once "Run console.log('hello') in the sandbox and tell me what it printed."
```

`--timings` enables terminal diagnostics on stderr. You can also set
`SANDBOX_TIMINGS=1` in `agent/.env`. Omit both for normal chat output.
The logs show each model request, the JavaScript tool duration, the Lima
round trip, and the entire agent turn. Model duration includes the provider
request, any retries, and generation of its response.

Within the sandbox, the logs separate snapshot preparation (which includes a
cold build when needed), disk cloning, Firecracker startup, API readiness,
snapshot restore, vsock connection, and sending code/executing/receiving its result.
`guest.run_and_reply` includes communication and output handling; it is not a
measurement of only the JavaScript statement's CPU time.

For example, one measured hello turn took about 3.29 seconds: 1.18 seconds for
the first model request, 0.97 seconds for the tool including Lima (0.88 seconds
inside the sandbox), and 1.14 seconds for the model's final reply. A five-second
agent turn can coexist with a sub-second sandbox execution. These are measured
boundaries, not a latency guarantee. `tool.javascript` contains `lima.roundtrip`,
which contains `sandbox.total`; do not add these overlapping totals together.

To measure just the sandbox from the repository root, skipping the model:

```bash
limactl shell fc -- node "$PWD/host/dist/cli.js" exec --timings --timeout 30 -- 'console.log("hello")'
```

The tool uses the controller's `--json` report in timing mode so guest stdout
and stderr stay separate from diagnostics. Timing data is printed locally and
is not included in the model's tool result. Logs omit prompts, source code,
model/tool output, and credentials. Normal stdout still contains the actual
response, including anything you explicitly ask a program to print.

## What this slice leaves out

The jailer is a second binary shipped with Firecracker. It starts first, chroots the Firecracker process, drops root, and applies a cgroup. The microVM already walls the guest off from the host. The jailer walls a buggy Firecracker process off from the rest of the host. This slice runs `firecracker` directly.

A later slice can keep a pool of restored VMs to prepare them before tool calls arrive. This version restores one fresh VM per execution.
