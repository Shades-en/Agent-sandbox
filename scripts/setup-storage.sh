#!/usr/bin/env bash
# Run inside fc. Btrfs lives in its own image file; the VM's existing ext4
# disk is left intact. Images, snapshots, and run disks share this filesystem.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run inside Lima: limactl shell fc -- ./scripts/setup-storage.sh' >&2
  exit 1
fi

BASE="${HOME}/.sandbox"
IMAGE="${BASE}/storage.btrfs"
STORAGE="${BASE}/storage"
mkdir -p "$BASE" "$STORAGE"
# Prevent two setup processes from creating/replacing the same backing image.
exec 9>"${BASE}/storage-setup.lock"
flock -n 9 || { echo "Storage setup is already running" >&2; exit 1; }
if ! command -v mkfs.btrfs >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y btrfs-progs
fi

# Only format a NEW file, never an existing image or a physical disk.
if [[ ! -e "$IMAGE" ]]; then
  TEMP_IMAGE=$(mktemp "${IMAGE}.XXXXXX")
  trap 'rm -f "$TEMP_IMAGE"' EXIT
  truncate -s "${SANDBOX_STORAGE_SIZE:-16G}" "$TEMP_IMAGE"
  mkfs.btrfs -L agent-sandbox "$TEMP_IMAGE"
  mv "$TEMP_IMAGE" "$IMAGE"
  trap - EXIT
fi
if [[ "$(sudo blkid -s TYPE -o value "$IMAGE")" != btrfs ]]; then
  echo "Refusing to format existing non-Btrfs image: ${IMAGE}" >&2
  exit 1
fi

# Let Linux mount it after a VM/Mac restart. Keep unrelated fstab entries.
# nofail lets fc boot even if the image goes missing; the controller then
# refuses execution instead of accidentally writing onto the ext4 directory.
sudo python3 - "$IMAGE" "$STORAGE" <<'PY'
from pathlib import Path
import sys

def escape(value):
    return value.replace("\\", "\\134").replace(" ", "\\040").replace("\t", "\\011")

image, mount = map(escape, sys.argv[1:])
fstab = Path("/etc/fstab")
text = fstab.read_text()
for line in text.splitlines():
    fields = line.split()
    if not fields or fields[0].startswith("#") or len(fields) < 3:
        continue
    if fields[1] == mount:
        if fields[0] != image or fields[2] != "btrfs":
            raise SystemExit(f"Conflicting fstab entry for {mount}; left unchanged")
        break
else:
    with fstab.open("a") as out:
        if text and not text.endswith("\n"):
            out.write("\n")
        out.write(f"{image} {mount} btrfs loop,noatime,nofail 0 0\n")
PY
sudo systemctl daemon-reload
if ! mountpoint -q "$STORAGE"; then
  sudo mount "$STORAGE"
fi
if [[ "$(findmnt -n -o FSTYPE --mountpoint "$STORAGE")" != btrfs ]] || \
   [[ "$(findmnt -n -o UUID --mountpoint "$STORAGE")" != "$(sudo blkid -s UUID -o value "$IMAGE")" ]]; then
  echo "Unexpected filesystem mounted at ${STORAGE}; left unchanged" >&2
  exit 1
fi
sudo chown "$(id -u):$(id -g)" "$STORAGE"
sudo chmod 700 "$STORAGE"
mkdir -p "$STORAGE/images" "$STORAGE/snapshots" "$STORAGE/run"

# Import the ext4 guest image once. The file CONTENT is an ext4 filesystem,
# while the host stores that file ON Btrfs, where it can be reflinked.
SOURCE="${BASE}/images/rootfs.ext4"
TARGET="${STORAGE}/images/rootfs.ext4"
if [[ ! -f "$SOURCE" ]]; then
  echo "Storage mounted. Run scripts/setup-host.sh to build the guest image." >&2
  exit 1
fi
if [[ ! -f "$TARGET" || "$SOURCE" -nt "$TARGET" ]]; then
  cp --reflink=auto --sparse=always -- "$SOURCE" "${TARGET}.tmp"
  mv "${TARGET}.tmp" "$TARGET"
fi

# Check the capability, rather than assuming a successful mount is enough.
PROBE=$(mktemp "${STORAGE}/reflink-check.XXXXXX")
trap 'rm -f "$PROBE" "${PROBE}.clone"' EXIT
printf 'original' > "$PROBE"
cp --reflink=always -- "$PROBE" "${PROBE}.clone"
printf 'changed' > "${PROBE}.clone"
[[ "$(cat "$PROBE")" == original ]]
echo "ready: Btrfs reflink storage at ${STORAGE}"
