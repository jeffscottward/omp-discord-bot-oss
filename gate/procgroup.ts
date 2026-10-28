/**
 * Plan P4: run an approved command in its own process group and stop the WHOLE group (children and
 * grandchildren), not only the bash that started them: SIGTERM to the group, then SIGKILL after a grace time.
 */
import { spawnSync } from "node:child_process";

export const KILL_GRACE_MS = 10_000;

/**
 * argv prefix that starts the command in a new process group of the SAME session (setpgid, not setsid).
 * So the command keeps the controlling terminal and the per-tty sudo ticket of the approval tab. With a
 * terminal on stdin the new group becomes the terminal's foreground group (keyboard input and Ctrl-C go
 * to the command). Usage: spawn(NEW_GROUP[0], [...NEW_GROUP.slice(1), "bash", "-c", cmd]).
 */
export const NEW_GROUP = [
  "/usr/bin/perl",
  "-MPOSIX",
  "-e",
  'setpgid(0, 0) or die "setpgid: $!\\n"; if (-t STDIN) { $SIG{TTOU} = "IGNORE"; tcsetpgrp(0, getpgrp()); $SIG{TTOU} = "DEFAULT"; } exec { $ARGV[0] } @ARGV or die "exec: $!\\n";',
  "--",
] as const;

/** Give the terminal back to this process's group after a NEW_GROUP command (no-op without a terminal). */
export function reclaimTerminal(): void {
  if (!process.stdin.isTTY) return;
  spawnSync("/usr/bin/perl", ["-MPOSIX", "-e", '$SIG{TTOU} = "IGNORE"; tcsetpgrp(0, getpgrp());'], { stdio: "inherit" });
}

/**
 * SIGTERM to process group `pgid`, then SIGKILL to it after `graceMs`. Resolves after the SIGKILL step
 * (await it so the process does not exit before that). A group that is already gone is ignored.
 */
export function stopGroup(pgid: number, graceMs = KILL_GRACE_MS): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return Promise.resolve();
  }
  return new Promise((done) =>
    setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
      done();
    }, graceMs),
  );
}
