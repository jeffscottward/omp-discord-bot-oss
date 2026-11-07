// Fixed tunnels from the sandbox to host-side destinations (one Unix socket each, mode 600):
// - status-monitor (127.0.0.1:3461): GET/HEAD and read-only WebSocket feeds only. The monitor's only
//   POST endpoint (2FA gateway login) is unreachable. status-monitor itself never places orders.
import { chmodSync, existsSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { STATUS_MONITOR_PORT } from "./sandbox.ts";

const KEEP_HEADERS = ["content-type", "cache-control", "last-modified", "etag"];

/** Pipe every connection to a fixed host:port. */
export function startTcpTunnel(socketPath: string, host: string, port: number): Server {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((c) => {
    const up = connect({ host, port });
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
    c.pipe(up);
    up.pipe(c);
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return server;
}

type WsData = { path: string; up?: WebSocket };

/** Read-only reverse proxy to status-monitor. */
export function startStatusMonitorProxy(socketPath: string, upstream = `127.0.0.1:${STATUS_MONITOR_PORT}`) {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = Bun.serve<WsData>({
    unix: socketPath,
    async fetch(req, srv) {
      const u = new URL(req.url);
      const path = `${u.pathname}${u.search}`;
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return srv.upgrade(req, { data: { path } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("status-monitor is read-only from Discord runs\n", { status: 405 });
      try {
        const r = await fetch(`http://${upstream}${path}`, { method: req.method, headers: { host: upstream, accept: req.headers.get("accept") ?? "*/*" } });
        const headers = new Headers();
        for (const h of KEEP_HEADERS) {
          const v = r.headers.get(h);
          if (v) headers.set(h, v);
        }
        return new Response(req.method === "HEAD" ? null : await r.arrayBuffer(), { status: r.status, headers });
      } catch (e) {
        return new Response(`status-monitor unreachable: ${(e as Error).message}\n`, { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(`ws://${upstream}${ws.data.path}`);
        ws.data.up = up;
        up.onmessage = (m) => ws.send(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
        up.onclose = () => ws.close();
        up.onerror = () => ws.close();
      },
      message() {}, // read-only: client messages are dropped
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
  chmodSync(socketPath, 0o600);
  return server;
}
