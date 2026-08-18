import { spawnSync } from 'node:child_process';

// Always resolve the package-manager version declared by the repository. A
// globally installed pnpm can be older and may not understand this lockfile.
const isWindows = process.platform === 'win32';
const command = isWindows ? 'corepack pnpm licenses list --prod --json' : 'corepack';
const args = isWindows ? [] : ['pnpm', 'licenses', 'list', '--prod', '--json'];
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  // Windows exposes Corepack as a .cmd shim; Node must launch that through the
  // command interpreter. All arguments above are fixed repository constants.
  shell: isWindows,
});

if (result.status !== 0) {
  process.stderr.write(
    result.stderr || result.error?.message || 'pnpm license scan failed\n',
  );
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(`license report is not valid JSON: ${String(error)}\n`);
  process.exit(1);
}

const allowedMissingMetadata = new Set([
  // khroma 2.1.0 omits package.json#license but ships an MIT `license` file.
  'khroma@2.1.0',
]);
const forbiddenGroups = ['Unknown', 'UNKNOWN', 'UNLICENSED', 'NOASSERTION'];
const unresolved = forbiddenGroups.flatMap((group) => {
  const entries = Array.isArray(report[group]) ? report[group] : [];
  return entries.flatMap((entry) => {
    const versions = Array.isArray(entry.versions)
      ? entry.versions
      : entry.version === undefined
        ? []
        : [entry.version];
    const ids = versions.map((version) => `${String(entry.name ?? '')}@${String(version)}`);
    return ids.length === 0 || ids.some((id) => !allowedMissingMetadata.has(id))
      ? ids.length > 0
        ? ids.filter((id) => !allowedMissingMetadata.has(id))
        : [`${String(entry.name ?? '<unknown>')}@<missing-version>`]
      : [];
  });
});
if (unresolved.length > 0) {
  process.stderr.write(`dependency license metadata is unresolved: ${unresolved.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
