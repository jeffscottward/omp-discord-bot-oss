import { copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tests use a fixed fake config (never the real ~/.config/omp-discord/config.json). Set before src/config.ts loads.
// A tmp copy: a test that saves config (overflow, stack categories) never changes the fixture in the repo.
const fixtureCopy = join(mkdtempSync(join(tmpdir(), "omp-bot-test-config-")), "config.test.json");
copyFileSync(join(import.meta.dir, "fixtures", "config.test.json"), fixtureCopy);
process.env.OMP_BOT_CONFIG = fixtureCopy;
// The stack catalog (src/stackcatalog.ts): never the real ~/.config/omp-discord/stacks.json. Tests that need one set
// their own path; this default does not exist, so the code defaults apply.
process.env.OMP_BOT_STACKS = join(tmpdir(), `omp-bot-test-stacks-${process.pid}-absent.json`);
delete process.env.FM_DIR;
delete process.env.OMP_FM_ITEMS;
import { seedSecretValuesForTests } from "../src/secrets.ts";

// Suite-wide: outbound tests must not depend on secret files in the real home directory.
seedSecretValuesForTests([]);
