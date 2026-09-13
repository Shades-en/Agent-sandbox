#!/usr/bin/env bash
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
sudo apt-get install -y e2fsprogs squashfs-tools curl ca-certificates python3 xz-utils acl
if [[ -e /dev/kvm ]]; then
  sudo setfacl -m "u:${USER}:rw" /dev/kvm
fi

if ! command -v node >/dev/null || [[ "$(node -p process.versions.node)" != 24.* ]]; then
  NODE_TAR="node-v24.22.0-linux-arm64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v24.22.0/${NODE_TAR}" -o "${WORK}/${NODE_TAR}"
  echo "fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143  ${WORK}/${NODE_TAR}" | sha256sum -c -
  sudo tar -xJf "${WORK}/${NODE_TAR}" -C /usr/local --strip-components=1
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
chmod 755 "${WORK}/squashfs-root/opt/sandbox/agent.py"
cp "${ROOT}/guest/sandbox-agent.service" \
  "${WORK}/squashfs-root/etc/systemd/system/sandbox-agent.service"
ln -sf /etc/systemd/system/sandbox-agent.service \
  "${WORK}/squashfs-root/etc/systemd/system/multi-user.target.wants/sandbox-agent.service"
sudo chown -R root:root "${WORK}/squashfs-root"
truncate -s 1G "${IMG}/rootfs.ext4.tmp"
sudo mkfs.ext4 -d "${WORK}/squashfs-root" -F "${IMG}/rootfs.ext4.tmp"
mv "${IMG}/rootfs.ext4.tmp" "${IMG}/rootfs.ext4"
echo "ready: ${BIN}/firecracker ${IMG}/vmlinux ${IMG}/rootfs.ext4"
