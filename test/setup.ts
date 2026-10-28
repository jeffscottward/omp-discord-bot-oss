import { join } from "node:path";

// Tests use a fixed fake config (never the real ~/.config/omp-discord/config.json). Set before src/config.ts loads.
process.env.OMP_BOT_CONFIG = join(import.meta.dir, "fixtures", "config.test.json");
delete process.env.FM_DIR;
delete process.env.OMP_FM_ITEMS;
import { seedSecretValuesForTests } from "../src/secrets.ts";

// Suite-wide: outbound tests must not depend on secret files in the real home directory.
seedSecretValuesForTests([]);
