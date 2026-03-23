import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function getDataDir(): string {
  const dir = process.env.VIBETRADE_DATA_DIR ?? join(homedir(), ".vibetrade-broker");
  mkdirSync(dir, { recursive: true });
  return dir;
}
