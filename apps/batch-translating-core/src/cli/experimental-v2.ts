/**
 * Experimental agent-core-v2 engine gate for the CLI surfaces.
 *
 * When the master switch `KIMI_CODE_EXPERIMENTAL_FLAG` is truthy, `batch-translating -p`
 * (print mode) routes to the native agent-core-v2 runner (see
 * `run-prompt.ts`), instead of the default v1 engine. The master switch also
 * enables every experimental feature flag in the engine. Unset / any
 * non-truthy value keeps the v1 path.
 *
 * Note: `batch-translating web` always boots kap-server (the agent-core-v2 engine
 * server) — it does not consult this switch.
 */

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUTHY_VALUES.has((env[key] ?? '').trim().toLowerCase());
}

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_V2_ENV, env);
}
