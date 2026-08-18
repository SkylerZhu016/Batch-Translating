import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const roots = process.argv.slice(2).map((path) => resolve(path));
if (roots.length === 0) {
  process.stderr.write('usage: node scripts/ci/scan-artifacts.mjs <artifact>...\n');
  process.exit(2);
}

const forbiddenNames = new Set(['.env', 'config.toml', 'credentials.json', 'runtime.json']);
const pemBegin = `-----${String.fromCharCode(66)}EGIN`;
const markers = [
  process.env.GITHUB_WORKSPACE,
  process.env.USERPROFILE,
  process.env.HOME,
  process.env.LOCALAPPDATA,
  `${pemBegin} PRIVATE KEY-----`,
  `${pemBegin} RSA PRIVATE KEY-----`,
  `${pemBegin} OPENSSH PRIVATE KEY-----`,
].filter((value) => typeof value === 'string' && value.length >= 4);
const credentialPatterns = [
  // Require a quoted literal for assignments. Bundled source legitimately
  // contains identifiers such as `access_token = tokenResponse.accessToken`;
  // treating an identifier as a secret makes the release scan unusable.
  /(?:api[_-]?key|access[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{24,}["']/gi,
  /bearer\s+[A-Za-z0-9_\-.]{24,}/gi,
  /sk-[A-Za-z0-9_-]{20,}/g,
];

const failures = [];
for (const root of roots) {
  for (const path of await filesUnder(root)) {
    if (forbiddenNames.has(basename(path).toLowerCase())) {
      failures.push(`${path}: forbidden runtime/config filename`);
      continue;
    }
    const bytes = await readFile(path);
    const content = bytes.toString('utf8');
    for (const marker of markers) {
      if (content.includes(marker)) failures.push(`${path}: contains local/private marker`);
    }
    for (const pattern of credentialPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) failures.push(`${path}: resembles an embedded credential`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`artifact scan passed for ${roots.length} target(s)\n`);

async function filesUnder(path) {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) throw new Error(`artifact target does not exist: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(child)));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}
