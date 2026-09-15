import http from "node:http";

import { BOOT_ARGS, GUEST_CID, MEM_SIZE_MIB, VCPU_COUNT } from "./constants.js";

export class ApiError extends Error {
  constructor(
    readonly urlPath: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`API PUT ${urlPath} returned ${status}: ${responseBody}`);
    this.name = "ApiError";
  }
}

export interface BootRequest {
  kernelPath: string;
  rootfsPath: string;
  vsockPath: string;
}

export interface ApiCall {
  path: string;
  body: unknown;
}

// Firecracker is configured before the guest boots. Each call is an HTTP PUT
// on the API socket. A 204 means "accepted". The guest starts only on the
// last call. There is no network interface in this slice.
export function bootCalls(request: BootRequest): ApiCall[] {
  return [
    {
      // CPU and memory. smt off means one thread per vCPU.
      path: "/machine-config",
      body: { vcpu_count: VCPU_COUNT, mem_size_mib: MEM_SIZE_MIB, smt: false },
    },
    {
      // Kernel file on the Lima host, plus the kernel command line.
      path: "/boot-source",
      body: { kernel_image_path: request.kernelPath, boot_args: BOOT_ARGS },
    },
    {
      // The guest's disk. path_on_host is the per-run copy, not the base image.
      // is_root_device tells Firecracker to add the root= argument for us.
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: request.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    },
    {
      // vsock device. guest_cid is the guest's address. uds_path is the Unix
      // socket on the Lima host that we connect to after boot.
      path: "/vsock",
      body: { guest_cid: GUEST_CID, uds_path: request.vsockPath },
    },
    {
      // Start the vCPUs. Everything above must already be configured.
      path: "/actions",
      body: { action_type: "InstanceStart" },
    },
  ];
}

// The process is started with a Unix socket instead of a TCP port.
// We configure the microVM by sending HTTP to that socket.
export function firecrackerArgs(apiSock: string, logPath: string): string[] {
  return ["--api-sock", apiSock, "--log-path", logPath];
}

const PUT_RESPONSE_TIMEOUT_MS = 5_000;

export function putJson(
  socketPath: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseTimeout: NodeJS.Timeout | undefined;

    const finish = (result: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      if (responseTimeout !== undefined) clearTimeout(responseTimeout);
      resolve(result);
    };

    let req: http.ClientRequest;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      if (responseTimeout !== undefined) clearTimeout(responseTimeout);
      req.destroy();
      reject(new Error(message));
    };

    req = http.request(
      {
        socketPath,
        path: urlPath,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        responseTimeout = setTimeout(() => {
          fail(`API PUT ${urlPath} timed out after ${PUT_RESPONSE_TIMEOUT_MS}ms waiting for response end`);
        }, PUT_RESPONSE_TIMEOUT_MS);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (err) => {
          fail(`API PUT ${urlPath} response error: ${err.message}`);
        });
        res.on("end", () => {
          finish({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (err) => {
      fail(`API PUT ${urlPath} request error: ${err.message}`);
    });
    req.end(payload);
  });
}

export async function configureAndStart(apiSock: string, request: BootRequest): Promise<void> {
  for (const call of bootCalls(request)) {
    const result = await putJson(apiSock, call.path, call.body);
    if (result.status !== 204) {
      throw new ApiError(call.path, result.status, result.body);
    }
  }
}
