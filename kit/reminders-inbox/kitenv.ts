// Read the kit settings file (KEY=VALUE lines; the shell kit scripts read the same file).
// File: $OMP_KIT_ENV, else ~/.config/omp-discord/kit.env. A variable that is already set in the environment wins.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export function loadKitEnv(): void {
  const home = process.env.HOME || homedir();
  const path = process.env.OMP_KIT_ENV || `${home}/.config/omp-discord/kit.env`;
  if (!existsSync(path)) return;
  for (let line of readFileSync(path, "utf8").split("\n")) {
    line = line.trim();
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    if (val.length >= 2 && val[0] === "'" && val.at(-1) === "'") val = val.slice(1, -1);
    else {
      if (val.length >= 2 && val[0] === '"' && val.at(-1) === '"') val = val.slice(1, -1);
      val = val.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => process.env[a ?? b] ?? "").replace(/^~(?=\/|$)/, home);
    }
    process.env[key] = val;
  }
}
