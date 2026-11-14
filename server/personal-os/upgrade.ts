// One `upgrade` listener for the whole HTTP server. /dcp/v1/connect (devices)
// and /api/cli-agents/stream (browsers) are both WebSockets; dispatching on the
// exact URL here keeps either handler from seeing the other's requests and
// means unknown upgrade paths are dropped instead of left hanging.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export const DEVICE_UPGRADE_PATH = "/dcp/v1/connect";
export const CLI_STREAM_PATH = "/api/cli-agents/stream";

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface UpgradeTargets {
  device: UpgradeHandler;
  stream: UpgradeHandler;
}

/** Routes an upgrade request by its exact path (a query string never selects a handler). */
export function routeUpgrade(targets: UpgradeTargets): UpgradeHandler {
  return (request, socket, head) => {
    const pathname = (request.url ?? "").split("?")[0];
    if (request.url === DEVICE_UPGRADE_PATH) targets.device(request, socket, head);
    else if (pathname === CLI_STREAM_PATH) targets.stream(request, socket, head);
    else socket.destroy();
  };
}

/** Registers the dispatcher on the server and returns it, so the owner can later swap it (workspaces.ts). */
export function installUpgrade(server: Server, targets: UpgradeTargets): UpgradeHandler {
  const listener = routeUpgrade(targets);
  server.on("upgrade", listener);
  return listener;
}
