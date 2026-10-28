// Integration test: real probes inside the Discord capability sandbox (bwrap + bridge sockets).
// Every bypass attempt must fail for lack of capability (no route, no key, no privilege, read-only
// file system); the allowed native paths must work. Never contacts account with order intent: the
// gateway probes are plain TCP connects that cannot be routed.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSandboxed } from "../src/omp.ts";
import { DEV_CHANNEL_ID, trusted } from "../src/config.ts";

const HAS_BWRAP = existsSync("/usr/bin/bwrap");
const HOME = homedir();
const OUTSIDE = join(HOME, `.omp-gate-int-probe-${process.pid}`);

function runInSandbox(script: string): Promise<{ code: number; out: string }> {
  const child = spawnSandboxed("int-test", join(HOME, "Github"), ["/bin/sh", "-c", script], { channelId: DEV_CHANNEL_ID });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const { promise, resolve } = Promise.withResolvers<{ code: number; out: string }>();
  child.on("close", (code) => resolve({ code: code ?? 1, out }));
  return promise;
}

const PY_CONNECT = (host: string, port: number) =>
  `timeout 15 /usr/bin/python3 -c 'import socket; socket.create_connection(("${host}", ${port}), timeout=5)'`;
const MWB = "~/Github/finance/example-bot";

// Each probe prints "<name>=<rc>" (rc 0 = the action succeeded).
const MUST_FAIL: [string, string][] = [
  ["ibapi_gateway_public", PY_CONNECT("1.2.3.4", 4003)],
  ["ibapi_gateway_tailnet", PY_CONNECT("100.64.0.10", 4003)],
  ["ibapi_gateway_name", PY_CONNECT("ib-gateway", 4004)],
  ["ssh_vps_docker", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 remote 'docker exec broker-nautilus-exec-node-watchdog-1 true'"],
  ["ssh_vps_ip", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 root@1.2.3.4 true"],
  ["ssh_via_proxy", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=3128' root@1.2.3.4 true"],
  ["ssh_mac", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 peer-host true"],
  ["ssh_key_visible", "ls ~/.ssh | grep -qv -e '^config$' -e '^known_hosts$'"],
  ["sudo_real", "/usr/bin/sudo -n true"],
  ["sudo_wrapper", "sudo -n true"],
  ["mwb_env_broker_creds", `grep -q . ${MWB}/.env`],
  ["any_env_value", "cat ~/Github/*/.env ~/Github/*/*/.env 2>/dev/null | grep -q ="],
  ["op_read_wrapper", "op read op://Private/x/password"],
  ["op_read_real", "timeout 10 /usr/bin/op read op://Private/x/password"],
  ["op_config_visible", "test -e ~/.config/op/config"],
  ["gh_token_real", "timeout 10 $(ls ~/.local/share/mise/installs/gh/*/gh_*/bin/gh | head -n 1) auth token"],
  ["gh_token_wrapper", "gh auth token"],
  ["bot_token_visible", "test -s ~/.config/omp-discord/bot.env"],
  ["rm_outside_repo", `rm -f ${OUTSIDE}`],
  ["write_bashrc", "touch ~/.bashrc"],
  ["write_user_unit", "touch ~/.config/systemd/user/evil.service"],
  ["write_service_repo", `touch ${MWB}/x-probe`],
  ["write_bridge_repo", "touch ~/Github/tools/omp-discord-bot/x-probe"],
  ["write_github_root", "touch ~/Github/x-probe"],
  ["systemd_run", "timeout 10 systemd-run --user true"],
  ["systemctl_start_wrapper", "systemctl --user start example-watch-rebalance.service"],
  ["systemctl_real", "timeout 10 /usr/bin/systemctl --user is-active status-monitor"],
  ["dbus_session", "test -S /run/user/$(id -u)/bus"],
  ["herdr_real_socket", "timeout 10 $(readlink -f ~/.local/bin/herdr) pane send-text --help >/dev/null && timeout 10 $(readlink -f ~/.local/bin/herdr) tab list"],
  ["herdr_type_wrapper", "herdr pane send-text wB:p3D 'echo hi'"],
  ["host_loopback", "curl -s -f -m 5 -o /dev/null http://127.0.0.1:47821/health"],
  ["host_omp_daemon", "curl -s -m 5 -o /dev/null http://127.0.0.1:4000/"],
  ["tailnet_via_proxy", "curl -s -f -m 5 -o /dev/null http://100.64.0.10:3461/api/health"],
  ["broker_https", "curl -s -f -m 8 -o /dev/null https://api.status.example.com/"],
  ["monitor_post", "curl -s -f -m 5 -o /dev/null -X POST http://127.0.0.1:3461/api/broker-2fa"],
];
const MUST_PASS: [string, string][] = [
  ["public_https", "curl -s -f -m 20 -o /dev/null https://example.com"],
  ["read_github", "ls ~/Github/finance/example-bot/market_watch >/dev/null"],
  ["scratch_writable", "touch ~/discord-scratch/probe && rm -f ~/discord-scratch/probe"],
  ["tmp_writable", "touch /tmp/probe && rm /tmp/probe"],
  ["monitor_snapshot", "curl -s -f -m 10 http://127.0.0.1:3461/api/snapshot | grep -q ."],
  ["systemctl_is_active", "systemctl --user is-active status-monitor"],
  ["herdr_agent_list", "herdr agent list | grep -q agents"],
];

// spawnSandboxed runs unsandboxed while the trusted-mode flag exists, so the probes would not test the sandbox.
// Opt-in (OMP_SANDBOX_INT=1): the probes name the owner's own services (example-bot, status-monitor, remote alias).
describe.skipIf(!HAS_BWRAP || trusted() || process.env.OMP_SANDBOX_INT !== "1")("Discord capability sandbox (real bwrap run)", () => {
  test(
    "bypass attempts fail for lack of capability; native reads work",
    async () => {
      writeFileSync(OUTSIDE, "probe");
      const all = [...MUST_FAIL, ...MUST_PASS];
      const script = all.map(([n, c]) => `(${c}) >/dev/null 2>&1; echo "${n}=$?"`).join("\n");
      const { out } = await runInSandbox(script);
      const rc = Object.fromEntries([...out.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
      if (process.env.SANDBOX_PROBE_REPORT) console.log(JSON.stringify(rc));
      for (const [n] of all) expect([n, rc[n] !== undefined]).toEqual([n, true]);
      expect(MUST_FAIL.map(([n]) => n).filter((n) => rc[n] === 0)).toEqual([]);
      expect(MUST_PASS.map(([n]) => n).filter((n) => rc[n] !== 0)).toEqual([]);
      expect(existsSync(OUTSIDE)).toBe(true); // rm outside repos did nothing
    },
    180_000,
  );
});

afterAll(() => rmSync(OUTSIDE, { force: true }));
