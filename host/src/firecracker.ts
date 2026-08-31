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

export function bootCalls(request: BootRequest): ApiCall[] {
  return [
    {
      path: "/machine-config",
      body: { vcpu_count: VCPU_COUNT, mem_size_mib: MEM_SIZE_MIB, smt: false },
    },
    {
      path: "/boot-source",
      body: { kernel_image_path: request.kernelPath, boot_args: BOOT_ARGS },
    },
    {
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: request.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    },
    {
      path: "/vsock",
      body: { guest_cid: GUEST_CID, uds_path: request.vsockPath },
    },
    {
      path: "/actions",
      body: { action_type: "InstanceStart" },
    },
  ];
}

export function firecrackerArgs(apiSock: string, logPath: string): string[] {
  return ["--api-sock", apiSock, "--log-path", logPath];
}

export function putJson(
  socketPath: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
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
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
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
