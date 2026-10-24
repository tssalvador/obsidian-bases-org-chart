import { readFile } from "node:fs/promises";

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

const [pkg, manifest, versions] = await Promise.all([
  readJson("package.json"),
  readJson("manifest.json"),
  readJson("versions.json"),
]);

const errors = [];
if (pkg.version !== manifest.version) {
  errors.push(`package.json is ${pkg.version}, but manifest.json is ${manifest.version}`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(
    `versions.json must map ${manifest.version} to manifest minAppVersion ${manifest.minAppVersion}`
  );
}

if (errors.length) {
  console.error("Release metadata is inconsistent:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Release metadata is synchronized at ${manifest.version} (Obsidian ${manifest.minAppVersion}+).`);
}
