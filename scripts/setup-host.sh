#!/usr/bin/env bash
# Run this inside the Lima VM, once, before any microVM boot.
# It downloads Firecracker, a guest kernel, and an Ubuntu root disk, then
# bakes the guest listener, its Node bootstrap, and Node.js into that disk.
# Nothing here starts a microVM.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="${HOME}"
BASE="${HOME_DIR}/.sandbox"
IMG="${BASE}/images"
BIN="${BASE}/bin"
WORK="${BASE}/work"
VER="v1.17.0"
SHA="e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256"
S3="https://s3.amazonaws.com/spec.ccfc.min"
MANIFEST="${BASE}/manifest.json"

mkdir -p "$IMG" "$BIN" "$WORK"
sudo apt-get update
sudo apt-get install -y e2fsprogs squashfs-tools curl ca-certificates python3 xz-utils acl btrfs-progs g++
if [[ -e /dev/kvm ]]; then
  # limactl shell does not set $USER, so id -un is the account that runs node.
  LIMA_USER="$(id -un)"
  sudo usermod -aG kvm "$LIMA_USER"
  # Opening a microVM makes udev reapply the stock kvm rule (root:kvm 0660).
  # That deletes a setfacl entry, so the next run is denied. This rule keeps
  # the device writable after every Firecracker exit.
  sudo tee /etc/udev/rules.d/99-firecracker-kvm.rules >/dev/null <<'EOF'
KERNEL=="kvm", GROUP="kvm", MODE="0666"
EOF
  sudo udevadm control --reload-rules
  sudo udevadm trigger --name-match=kvm
fi

# Same Node build for the Lima host (runs the controller) and the microVM
# (runs JavaScript). The guest gets filtered public HTTPS access.
NODE_VER="v24.22.0"
NODE_TAR="node-${NODE_VER}-linux-arm64.tar.xz"
NODE_SHA="fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143"
NODE_TGZ="${WORK}/${NODE_TAR}"
if [[ ! -f "$NODE_TGZ" ]]; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${NODE_TAR}" -o "${NODE_TGZ}.tmp"
  echo "${NODE_SHA}  ${NODE_TGZ}.tmp" | sha256sum -c -
  mv "${NODE_TGZ}.tmp" "$NODE_TGZ"
fi
if ! command -v node >/dev/null || [[ "$(node -p process.versions.node)" != 24.* ]]; then
  sudo tar -xJf "$NODE_TGZ" -C /usr/local --strip-components=1
fi

if [[ ! -f "$MANIFEST" ]]; then
  ARCH="$(uname -m)"
  PREFIX=$(curl -fsSL "${S3}?list-type=2&prefix=firecracker-ci/&delimiter=/" \
    | grep -oP "(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)" \
    | sort | tail -1)
  KERNEL_KEY=$(curl -fsSL "${S3}?list-type=2&prefix=${PREFIX}${ARCH}/vmlinux-" \
    | grep -oP "(?<=<Key>)(${PREFIX}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
  ROOTFS_KEY=$(curl -fsSL "${S3}?list-type=2&prefix=${PREFIX}${ARCH}/ubuntu-" \
    | grep -oP "(?<=<Key>)(${PREFIX}${ARCH}/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" \
    | sort -V | tail -1)
  printf '{"firecracker":"%s","kernel":"%s","rootfs":"%s"}\n' \
    "$VER" "${S3}/${KERNEL_KEY}" "${S3}/${ROOTFS_KEY}" > "$MANIFEST"
fi

FC_TGZ="${WORK}/firecracker-${VER}-aarch64.tgz"
if [[ ! -x "${BIN}/firecracker" ]]; then
  curl -fsSL -o "$FC_TGZ" \
    "https://github.com/firecracker-microvm/firecracker/releases/download/${VER}/firecracker-${VER}-aarch64.tgz"
  echo "${SHA}  ${FC_TGZ}" | sha256sum -c -
  tar -xzf "$FC_TGZ" -C "$WORK"
  cp "${WORK}/release-${VER}-aarch64/firecracker-${VER}-aarch64" "${BIN}/firecracker"
  chmod 755 "${BIN}/firecracker"
fi

KERNEL_URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kernel"])' "$MANIFEST")
ROOTFS_URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rootfs"])' "$MANIFEST")

if [[ ! -f "${IMG}/vmlinux" ]]; then
  curl -fsSL -o "${IMG}/vmlinux.tmp" "$KERNEL_URL"
  mv "${IMG}/vmlinux.tmp" "${IMG}/vmlinux"
fi
if [[ ! -f "${IMG}/ubuntu.squashfs" ]]; then
  curl -fsSL -o "${IMG}/ubuntu.squashfs.tmp" "$ROOTFS_URL"
  mv "${IMG}/ubuntu.squashfs.tmp" "${IMG}/ubuntu.squashfs"
fi

sudo rm -rf "${WORK}/squashfs-root"
unsquashfs -d "${WORK}/squashfs-root" "${IMG}/ubuntu.squashfs"
mkdir -p "${WORK}/squashfs-root/opt/sandbox" \
  "${WORK}/squashfs-root/etc/systemd/system/multi-user.target.wants"
cp "${ROOT}/guest/agent.py" "${WORK}/squashfs-root/opt/sandbox/agent.py"
cp "${ROOT}/guest/runtime.cjs" "${WORK}/squashfs-root/opt/sandbox/runtime.cjs"
# Use the pinned Node headers. The addon calls that Node process's OpenSSL.
g++ -shared -fPIC -I/usr/local/include/node "${ROOT}/guest/reseed.cc" \
  -o "${WORK}/squashfs-root/opt/sandbox/reseed.node"
chmod 755 "${WORK}/squashfs-root/opt/sandbox/agent.py"
cp "${ROOT}/guest/sandbox-agent.service" \
  "${WORK}/squashfs-root/etc/systemd/system/sandbox-agent.service"
# Replace the systemd-resolved stub symlink with public resolvers.
rm -f "${WORK}/squashfs-root/etc/resolv.conf"
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:1 attempts:2\n' > "${WORK}/squashfs-root/etc/resolv.conf"
ln -sf /etc/systemd/system/sandbox-agent.service \
  "${WORK}/squashfs-root/etc/systemd/system/multi-user.target.wants/sandbox-agent.service"
# /usr/local/bin is already on the guest PATH. The agent runs this node
# with the tool source on stdin. There is no shell inside the microVM.
sudo tar -xJf "$NODE_TGZ" -C "${WORK}/squashfs-root/usr/local" --strip-components=1
sudo chown -R root:root "${WORK}/squashfs-root"
sudo chroot "${WORK}/squashfs-root" /usr/local/bin/node -e 'require("/opt/sandbox/reseed.node").reseed(Buffer.alloc(64)); process.stdout.write(process.version + "\n")'
truncate -s 1G "${IMG}/rootfs.ext4.tmp"
sudo mkfs.ext4 -d "${WORK}/squashfs-root" -F "${IMG}/rootfs.ext4.tmp"
mv "${IMG}/rootfs.ext4.tmp" "${IMG}/rootfs.ext4"
"${ROOT}/scripts/setup-storage.sh"
"${ROOT}/scripts/setup-network.sh"
echo "ready: ${BIN}/firecracker ${IMG}/vmlinux ${BASE}/storage/images/rootfs.ext4"
