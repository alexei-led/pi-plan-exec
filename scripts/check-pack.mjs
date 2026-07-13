import { execFileSync } from "node:child_process";

const ALWAYS_ALLOWED = new Set(["LICENSE", "README.md", "package.json"]);
const REQUIRED = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "skills/exec-plan/SKILL.md",
  "src/index.ts",
]);
const RUNTIME_PATHS = [/^src\/[^/]+\.ts$/, /^skills\/exec-plan\/SKILL\.md$/];

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
);
const parsed = JSON.parse(output);
const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
if (!manifest || !Array.isArray(manifest.files)) {
  throw new Error("npm pack did not return a package file manifest.");
}

const files = manifest.files.map((entry) => entry.path).sort();
const unexpected = files.filter(
  (file) =>
    !ALWAYS_ALLOWED.has(file) &&
    !RUNTIME_PATHS.some((pattern) => pattern.test(file)),
);
const missing = [...REQUIRED].filter((file) => !files.includes(file));

if (unexpected.length > 0 || missing.length > 0) {
  if (unexpected.length > 0) {
    console.error(`Unexpected package files:\n${unexpected.map((file) => `- ${file}`).join("\n")}`);
  }
  if (missing.length > 0) {
    console.error(`Missing required package files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
  }
  process.exit(1);
}

console.log(
  `${manifest.name}@${manifest.version}: ${files.length} files, ${manifest.unpackedSize} bytes unpacked`,
);
for (const file of files) console.log(`- ${file}`);
