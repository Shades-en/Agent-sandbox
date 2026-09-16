# Firecracker command sandbox

A sandbox where an Ari agent runs one JavaScript program inside a Firecracker microVM. The program returns stdout, stderr, and an exit code.

Date: 2026-10-16

## Goal

Teach the Firecracker pieces an agent sandbox uses, by making them runnable:

- the Linux host and `/dev/kvm`
- the API socket
- a guest kernel and root disk
- vsock as the only door into the guest

The success check is: from the Mac, an Ari tool runs `echo hello` and the string `hello` was produced by bash inside a microVM.

## Three places

| Place | What it is | What runs there |
| --- | --- | --- |
| Mac | The developer machine. Apple M5, macOS 26. | Ari, and the agent program in this repo. |
| Lima VM | The Firecracker host. Ubuntu aarch64, KVM via Lima `nestedVirtualization`. Instance name `fc`. | The `firecracker` process and the TypeScript controller. |
| microVM | The guest. A smaller Linux that Firecracker boots. | `guest/agent.py` and the bash command. |

Ari never talks to Firecracker directly. The tool on the Mac runs `limactl shell fc -- node … exec -- <command>`. The controller inside Lima owns the API socket and the vsock connection.

## Out of scope

This slice does not include:

- the Firecracker jailer
- snapshots and restore
- a guest network interface, tap devices, or NAT
- more than one microVM at a time
- mounting a project directory into the guest
- changes to the Ari repository

The README names the jailer and snapshots as the next slices and explains why they matter. It does not implement them.

## Repository layout

```
lima.yaml                 Lima instance. Ubuntu, vz, nested virtualization.
README.md                 The lesson and the commands to run.
guest/agent.py            Vsock listener, baked into the root disk.
guest/sandbox-agent.service
host/                     TypeScript controller. No Ari dependency.
  src/frame.ts            Length-prefixed JSON frames.
  src/firecracker.ts      API socket client and process spawn.
  src/vsock.ts            CONNECT handshake and the byte pipe.
  src/cli.ts              `exec` command.
  test/frame.test.ts
agent/                    Runs on the Mac only.
  package.json            Depends on ari via file:../../ai/ari.
  src/bash-tool.ts        defineTool execute -> limactl shell.
  src/run.ts              createAgent with that single tool.
scripts/setup-host.sh     Inside Lima: Firecracker binary, kernel, root disk.
scripts/test-integration.sh
```

`host/` and `agent/` are separate packages. `pnpm install` inside Lima must not need the Ari checkout. Ari is installed only on the Mac, from `agent/`.

## Pinned software

- Firecracker **v1.17.0**, asset `firecracker-v1.17.0-aarch64.tgz`, checksum checked against the release's `.sha256.txt`.
- Guest kernel: the newest `vmlinux-*` for `aarch64` from the Firecracker CI bucket documented in upstream `getting-started.md` (`https://s3.amazonaws.com/spec.ccfc.min`).
- Guest root disk: the matching Ubuntu squashfs from that same CI prefix, built into an ext4 image with the guest agent installed.
- `scripts/setup-host.sh` writes `~/.sandbox/manifest.json` with the resolved kernel URL, rootfs URL, and Firecracker version. A later run reuses those URLs and does not download them again. It rebuilds `rootfs.ext4` from the cached squashfs on every run, so edits to `guest/agent.py` or the systemd unit are picked up. Deleting the manifest forces a fresh download.

Large files stay on the Lima VM's own disk, under `~/.sandbox/`:

```
~/.sandbox/bin/firecracker
~/.sandbox/images/vmlinux
~/.sandbox/images/rootfs.ext4
~/.sandbox/manifest.json
~/.sandbox/run/<id>/
```

The git repo does not store the kernel, the root disk, or the Firecracker binary.

## Lima host

`lima.yaml`:

- `vmType: vz`
- `nestedVirtualization: true` (Lima 2.1 supports this on Apple M3 or later; this machine is an M5)
- 4 CPUs, 4 GiB RAM
- the repo directory mounted writable
- instance name `fc`

`scripts/setup-host.sh` runs inside the VM. It installs Node.js 24 and the tools needed to build an ext4 image (`e2fsprogs`, `unsquashfs`, `curl`). It downloads Firecracker, the kernel, and the Ubuntu squashfs. It unsquashes the rootfs, copies `guest/agent.py` to `/opt/sandbox/agent.py`, installs `guest/sandbox-agent.service`, enables that unit, and builds a 1 GiB ext4 image.

The controller's first action is to open `/dev/kvm`. If that fails, it exits 1 and prints that the Lima VM has no KVM and that nested virtualization did not come up. It does not start Firecracker.

## One command

```bash
limactl start --name=fc lima.yaml
limactl shell fc -- ./scripts/setup-host.sh
limactl shell fc -- node host/dist/cli.js exec --timeout 10 -- echo hello
```

`exec` joins every argument after `--` with a single space and sends that string to the guest. The guest runs it as `bash -c` with `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.

Default command timeout is 10 seconds. `--timeout` changes that value. The boot wait is a separate fixed 15 seconds.

### Boot sequence

The controller creates `~/.sandbox/run/<id>/` where `<id>` is `<pid>-<8 hex chars>`.

1. `cp --reflink=auto` the base `rootfs.ext4` into the run directory. If the filesystem refuses the reflink, it copies the file and prints one line saying so. The base image is never mounted or written.
2. Spawn `firecracker --api-sock <run>/api.sock`. The child stdout and stderr go to `<run>/serial.log`. Firecracker's own log goes to `<run>/firecracker.log` via `--log-path`.
3. When the API socket accepts connections, send these PUT requests, in order, and require HTTP 204:

| Path | Body |
| --- | --- |
| `/machine-config` | `vcpu_count` 1, `mem_size_mib` 256, `smt` false |
| `/boot-source` | `kernel_image_path` of the CI kernel. `boot_args`: `keep_bootcon console=ttyS0 reboot=k panic=1` |
| `/drives/rootfs` | `drive_id` `rootfs`, `path_on_host` of the per-run copy, `is_root_device` true, `is_read_only` false |
| `/vsock` | `guest_cid` 3, `uds_path` `<run>/v.sock` |
| `/actions` | `action_type` `InstanceStart` |

No network interface is configured. Firecracker adds the root-device kernel argument because `is_root_device` is true.

4. Connect to `<run>/v.sock` and send `CONNECT 5000\n`. Read until `\n`. The expected reply is `OK <port>\n`. If Firecracker closes the socket because the guest is not listening yet, retry until the 15 second boot deadline.
5. Write one request frame. Read one response frame.
6. Print `stdout` to the controller's stdout and `stderr` to the controller's stderr. Exit with the guest `exitCode` for every integer in `0..255`.
7. Always kill the Firecracker process and leave the run directory in place so a failure can be inspected. The serial log is the kernel boot text.

### Frame format

A frame is a 4-byte big-endian length followed by that many UTF-8 JSON bytes. The length counts the JSON only. A frame longer than 1 MiB is rejected.

Request:

```json
{ "command": "echo hello" }
```

Response:

```json
{ "stdout": "hello\n", "stderr": "", "exitCode": 0, "truncated": false }
```

The guest caps `stdout` and `stderr` at 256 KiB each. When either side is cut, `truncated` is true. `exitCode` is the bash status, an integer `0..255`.

### Guest agent

`guest/agent.py` is Python 3 from the Ubuntu rootfs. systemd starts it at boot via `sandbox-agent.service` (`WantedBy=multi-user.target`, `Restart=no`).

It listens on `AF_VSOCK` port 5000, bound to `VMADDR_CID_ANY`. It accepts one connection, reads one request frame, runs the command, writes one response frame, and exits.

The process is started as:

```text
bash -c <command>
```

with the PATH above and no other inherited environment. The working directory is `/`.

### Failure behavior

| Condition | Exit | What the user sees |
| --- | --- | --- |
| `/dev/kvm` missing | 1 | The nested-virtualization hint. Firecracker is not started. |
| An API call returns a non-204 | 1 | The response body, then the path of `serial.log`. |
| No successful `CONNECT` within 15 seconds | 1 | The path of `serial.log`. |
| Command exceeds `--timeout` | 124 | The word `timeout` on stderr. The microVM is killed. No response frame is required. |
| Response frame is not valid JSON or fails the field checks | 1 | The parse error. |
| Guest `exitCode` outside `0..255` | 1 | The response JSON. |

Killing the Firecracker process is the timeout and the shutdown path. The controller does not send `InstanceHalt` in this slice.

## Ari tool

`agent/package.json` depends on:

- `ari` at `file:../../ai/ari` (the checkout at `~/code/personal/ai/ari`)
- `ai`, `@ai-sdk/openai`, and `zod`

The Mac builds Ari once (`pnpm build` in that repo) before `pnpm install` in `agent/`. This repo does not modify Ari.

`agent/src/bash-tool.ts` exports a tool built with `defineTool`:

- `description`: run a shell command inside the Firecracker sandbox
- `input`: `{ command: string }`
- `effect`: `destructive`
- `execute`: spawn `limactl`, arguments `shell`, `fc`, `--`, `node`, `<absolute path to host/dist/cli.js>`, `exec`, `--timeout`, `10`, `--`, and the command string as one argument

The tool result is `{ stdout, stderr, exitCode }`. A controller timeout (exit 124, empty stdout, stderr exactly `timeout\n`) becomes `{ stdout: "", stderr: "timeout", exitCode: 124 }`. A guest command that itself exits 124 is returned with that command's own stdout and stderr. Any other controller failure rejects the tool call with the controller's stderr.

`agent/src/run.ts` builds an agent with `createAgent`, one model from `createOpenAI()` (`ARI_EXAMPLE_MODEL`, default `gpt-5.4-mini`), `memorySessionStore()`, and this single tool. It reads one prompt from argv, runs one turn, and prints the final assistant text. It requires `OPENAI_API_KEY`.

## Tests

`host/test/frame.test.ts` uses `node:test`. It runs on the Mac with no VM. It covers:

- a round trip of a request and a response
- a stdout value that contains newlines and NUL-free binary-looking text
- rejection of a length over 1 MiB
- rejection of a truncated buffer
- rejection of JSON missing `exitCode`

`scripts/test-integration.sh` runs inside Lima. It skips with a clear message when `/dev/kvm` is missing. Otherwise it runs:

```text
node host/dist/cli.js exec --timeout 10 -- echo hello
```

and requires stdout `hello\n` and exit 0. A second run of `false` must exit non-zero.

## README

The README is the lesson. It walks through, in this order:

1. The three places, and which one Firecracker calls the host.
2. Why `/dev/kvm` has to exist inside Lima.
3. The API socket: machine config, boot source, root drive, vsock, `InstanceStart`.
4. vsock: context id and port, virtio rings, the `CONNECT` / `OK` handshake, and why the guest has no IP address.
5. The exact commands for setup, `echo hello`, and the Ari tool.
6. A short section on the jailer and on snapshots: what each is for, and that this slice does not use them.

## Next slices

Not designed here, and not part of this implementation:

1. Run Firecracker under the jailer.
2. Snapshot a booted guest and restore it for the next command.
3. Keep a warm pool of restored VMs so the Ari tool does not pay a full boot per call.
