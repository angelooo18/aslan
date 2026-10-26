import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [target, examplePath] = process.argv.slice(2);
if (!target || !examplePath) {
  console.error("usage: node merge-settings.mjs <settings.json> <settings.example.json>");
  process.exit(1);
}

const example = JSON.parse(readFileSync(examplePath, "utf8"));
let current = {};

if (existsSync(target)) {
  const raw = readFileSync(target, "utf8");
  current = raw.trim() ? JSON.parse(raw) : {};
  const backup = `${target}.aslan-backup-${Date.now()}`;
  copyFileSync(target, backup);
  console.log(`settings backup: ${backup}`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const added = [];

function merge(destination, source, prefix = "") {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in destination)) {
      destination[key] = structuredClone(value);
      added.push(path);
    } else if (isObject(value) && isObject(destination[key])) {
      merge(destination[key], value, path);
    }
  }
}

merge(current, example);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`, "utf8");

console.log(added.length > 0 ? `settings defaults added: ${added.join(", ")}` : "settings defaults already present; nothing to add");
