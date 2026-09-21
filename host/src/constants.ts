// Sizes and timeouts for one microVM. Firecracker itself reads the machine
// numbers below through the API. The frame and timeout numbers are ours.

// One JSON message on the vsock pipe. The 4-byte length is not included.
export const MAX_FRAME_BYTES = 1024 * 1024;
// Guest stdout and stderr are cut here so one command cannot fill the frame.
export const MAX_STREAM_BYTES = 256 * 1024;
// How long we wait for the API socket and for the guest to answer CONNECT.
export const BOOT_TIMEOUT_MS = 15_000;
// How long the JavaScript program itself may run, after the guest is up.
export const DEFAULT_COMMAND_TIMEOUT_SEC = 10;
// The guest agent listens here. The host dials it with "CONNECT 5000".
export const VSOCK_PORT = 5000;
// vsock address of this guest. The host is always context id 2.
export const GUEST_CID = 3;
export const MEM_SIZE_MIB = 256;
export const VCPU_COUNT = 1;
// Kernel arguments. keep_bootcon and console=ttyS0 send boot text to serial.log.
export const BOOT_ARGS = "keep_bootcon console=ttyS0 reboot=k panic=1 net.ifnames=0 ipv6.disable=1";
