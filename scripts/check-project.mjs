import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

const requiredFiles = [
  "www/index.html",
  "www/native-adapter.js",
  "www/sw.js",
  "www/manifest.webmanifest",
  "www/icon-192.png",
  "www/icon-512.png",
  "android/app/src/main/AndroidManifest.xml",
  "ios/App/App/Info.plist",
  "capacitor.config.json",
  "package-lock.json",
];

for (const relative of requiredFiles) {
  await fs.access(path.join(root, relative));
}

for (const relative of [
  "package.json",
  "capacitor.config.json",
  "www/manifest.webmanifest",
]) {
  JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

const config = JSON.parse(
  await fs.readFile(path.join(root, "capacitor.config.json"), "utf8"),
);
assert.equal(config.plugins.CapacitorHttp.enabled, true);
assert.equal(config.webDir, "www");

const index = await fs.readFile(path.join(root, "www/index.html"), "utf8");
assert.match(index, /native-adapter\.js/);

const bundle = await fs.readFile(
  path.join(root, "www/assets/index-CyRXoI_r.js"),
  "utf8",
);
const adapter = await fs.readFile(
  path.join(root, "www/native-adapter.js"),
  "utf8",
);
assert.match(adapter, /model: "gpt-5\.6-sol"/);
assert.match(adapter, /baseUrl: "https:\/\/tokenclub\.info"/);

const secretMatches = bundle.match(/sk-[A-Za-z0-9_-]{16,}/g) || [];
assert.equal(secretMatches.length, 0, "前端文件中不应该包含真实 API 密钥");

const syntax = spawnSync(process.execPath, ["--check", "www/native-adapter.js"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(syntax.status, 0, syntax.stderr);

const adapterTest = spawnSync(
  process.execPath,
  ["scripts/test-native-adapter.mjs"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(adapterTest.status, 0, adapterTest.stderr || adapterTest.stdout);

console.log("Aurora AI mobile project checks: PASS");
