import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
const directory = path.resolve(import.meta.dirname, "..", "native");
mkdirSync(directory, { recursive: true });
for (const entry of readdirSync(directory)) rmSync(path.join(directory, entry), { force: true });
