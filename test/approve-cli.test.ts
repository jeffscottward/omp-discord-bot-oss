// omp-approve argument parsing. Incident 2026-10-13/15/16: `omp-approve --help` queued the literal
// command `--help` for approval three times; the owner approved one of them.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApproveArgs } from "../gate/cli.ts";

describe("parseApproveArgs", () => {
  test("help flags print help and queue nothing", () => {
    expect(parseApproveArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseApproveArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseApproveArgs(["--wait", "--help"])).toEqual({ kind: "help" });
  });

  test("unknown or misspelled options are errors, not commands", () => {
    for (const a of [["--version"], ["--wiat", "ls"], ["-x"], ["--status=abc"]]) expect(parseApproveArgs(a).kind).toBe("error");
  });

  test("--status and --wait-id need exactly one id", () => {
    expect(parseApproveArgs(["--status"]).kind).toBe("error");
    expect(parseApproveArgs(["--wait-id"]).kind).toBe("error");
    expect(parseApproveArgs(["--status", "--help"]).kind).toBe("error");
    expect(parseApproveArgs(["--status", "a", "b"]).kind).toBe("error");
    expect(parseApproveArgs(["--status", "hghmzfhp"])).toEqual({ kind: "status", id: "hghmzfhp" });
    expect(parseApproveArgs(["--wait-id", "7dwhnpjf"])).toEqual({ kind: "wait-id", id: "7dwhnpjf" });
  });

  test("empty command and --reason without value are errors", () => {
    expect(parseApproveArgs([]).kind).toBe("error");
    expect(parseApproveArgs(["--wait"]).kind).toBe("error");
    expect(parseApproveArgs(["--reason"]).kind).toBe("error");
    expect(parseApproveArgs(["--reason", "--", "ls"]).kind).toBe("error");
  });

  test("normal requests keep the exact command", () => {
    expect(parseApproveArgs(["sudo tailscale set --exit-node="])).toEqual({ kind: "request", wait: false, reason: "", command: "sudo tailscale set --exit-node=" });
    expect(parseApproveArgs(["--wait", "--reason", "restore exit", "--", "sudo", "true"])).toEqual({ kind: "request", wait: true, reason: "restore exit", command: "sudo true" });
    expect(parseApproveArgs(["--reason=why", "ls", "-la"])).toEqual({ kind: "request", wait: false, reason: "why", command: "ls -la" });
    // Flags after the command start belong to the command.
    expect(parseApproveArgs(["git", "--help"])).toEqual({ kind: "request", wait: false, reason: "", command: "git --help" });
    // `--` ends the options; the command after it is kept as is.
    expect(parseApproveArgs(["--wait", "--", "ls", "-la"])).toEqual({ kind: "request", wait: true, reason: "", command: "ls -la" });
  });
  test("P4: a command whose first word starts with '-' is refused, also after '--'", () => {
    for (const a of [["--", "--weird"], ["--", "-rf", "/"], ["--reason", "x", "--", "-x"], ["--", " -x"], ["--", "-"]]) {
      const r = parseApproveArgs(a);
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.message).toContain("nothing was queued");
    }
  });
});

describe("omp-approve process", () => {
  const cli = join(import.meta.dir, "../gate/cli.ts");
  const dir = mkdtempSync(join(tmpdir(), "approve-cli-"));
  const sock = join(dir, "hostexec.sock");

  // Async spawn: the fake broker runs in this test process, so a blocking spawnSync would stall its accept loop.
  const run = async (args: string[]) => {
    // `timeout` is a kill guard for a hung child, not a wait: a correct run exits in well under a second.
    const p = Bun.spawn([process.execPath, cli, "omp-approve", ...args], { env: { ...process.env, OMP_GATE_SOCKET: sock }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, status };
  };

  test("--help and bad flags exit without contacting the broker", async () => {
    let connections = 0;
    const server = createServer((c) => {
      connections++;
      c.end(JSON.stringify({ id: "SHOULDNOT", expiresAt: 0 }));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const help = await run(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("usage: omp-approve");
      for (const args of [["--status"], ["--version"], ["--wait"]]) {
        const bad = await run(args);
        expect(bad.status).toBe(2);
        expect(bad.stderr).toContain("nothing was queued");
      }
      expect(connections).toBe(0);
      // Control: a real request does reach the broker, so the zero count above is meaningful.
      const ok = await run(["echo", "hi"]);
      expect(ok.stdout).toContain("SHOULDNOT");
      expect(connections).toBe(1);
    } finally {
      server.close();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
