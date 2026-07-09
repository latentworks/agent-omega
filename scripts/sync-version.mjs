#!/usr/bin/env node
// The root VERSION file is Agent Omega's only editable version source.
// Run `npm run version:sync` after changing it; CI runs `version:check`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const version = read('VERSION').trim();
const prereleaseId = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${prereleaseId}(?:\\.${prereleaseId})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

if (!semver.test(version)) {
  throw new Error(`VERSION must be valid SemVer; got ${JSON.stringify(version)}`);
}

const coreVersion = version.replace(/[-+].*$/, '');
const assemblyVersion = `${coreVersion}.0`;
const releaseState = version.includes('-') ? 'Beta' : 'Stable';
let changed = false;

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function update(path, transform) {
  const before = read(path);
  const after = transform(before);
  if (after === before) return;
  changed = true;
  if (!checkOnly) writeFileSync(resolve(root, path), after, 'utf8');
  console.log(`${checkOnly ? 'would update' : 'updated'} ${path}`);
}

function replaceOne(text, pattern, replacement, path) {
  if (!pattern.test(text)) throw new Error(`Expected version surface missing in ${path}`);
  return text.replace(pattern, replacement);
}

function updateJson(path, mutate) {
  const source = read(path);
  const data = JSON.parse(source);
  mutate(data);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  update(path, () => `${JSON.stringify(data, null, 2).replaceAll('\n', newline)}${newline}`);
}

updateJson('package.json', data => { data.version = version; });
updateJson('package-lock.json', data => {
  data.version = version;
  if (!data.packages?.['']) throw new Error('package-lock.json has no root package entry');
  data.packages[''].version = version;
});

update('AgentOmega.csproj', text => {
  text = replaceOne(text, /<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`, 'AgentOmega.csproj');
  text = replaceOne(text, /<AssemblyVersion>[^<]+<\/AssemblyVersion>/, `<AssemblyVersion>${assemblyVersion}</AssemblyVersion>`, 'AgentOmega.csproj');
  return replaceOne(text, /<FileVersion>[^<]+<\/FileVersion>/, `<FileVersion>${assemblyVersion}</FileVersion>`, 'AgentOmega.csproj');
});

update('mac/Info.plist', text => {
  text = replaceOne(text, /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${coreVersion}$2`, 'mac/Info.plist');
  return replaceOne(text, /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${coreVersion}$2`, 'mac/Info.plist');
});

update('ui/app.html', text => {
  const pattern = /(<span>agent-omega · )v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(<\/span>)/g;
  if ([...text.matchAll(pattern)].length !== 2) throw new Error('Expected two home-footer version labels in ui/app.html');
  return text.replaceAll(pattern, `$1v${version}$2`);
});

update('ui/ao-boot-3.js', text => {
  text = replaceOne(text, /(AGENT-OMEGA  SECURE BOOT   )v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1v${version}`, 'ui/ao-boot-3.js');
  return replaceOne(text, /(agent-omega · )v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1v${version}`, 'ui/ao-boot-3.js');
});

update('REMOTE.md', text => replaceOne(text, /^> \*\*(?:Beta|Stable) \(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\)\./m, `> **${releaseState} (v${version}).`, 'REMOTE.md'));

if (checkOnly && changed) {
  throw new Error('Version surfaces are out of sync. Run: npm run version:sync');
}

console.log(changed ? 'Version surfaces synchronized.' : `Version surfaces already synchronized at ${version}.`);
