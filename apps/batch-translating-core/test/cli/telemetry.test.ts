/**
 * Tests for the CLI telemetry bootstrap helpers, focusing on the
 * `batch-translating web` host wiring and the disabled telemetry contract in `cli/telemetry.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeTelemetry: vi.fn(),
  createKimiDeviceId: vi.fn(() => 'device-123'),
  resolveKimiHome: vi.fn(() => '/home/.batch-translating'),
  resolveConfigPath: vi.fn(() => '/home/.batch-translating/config.toml'),
  loadRuntimeConfigSafe: vi.fn(
    (): {
      config: { defaultModel?: string; telemetry?: boolean };
      fileError: Error | undefined;
    } => ({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    }),
  ),
  getCachedAccessToken: vi.fn(async () => null),
}));

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setTelemetryContext: vi.fn(),
  track: vi.fn(),
  withTelemetryContext: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-oauth', async (importOriginal) => {
  // Spread the real module: the SDK's v2 client pulls agent-core-v2 into the
  // import graph, which subclasses KimiOAuthToolkit from this package.
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth')>();
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'managed:kimi-code',
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    resolveConfigPath: mocks.resolveConfigPath,
    loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
    KimiAuthFacade: vi.fn(function () {
      return { getCachedAccessToken: mocks.getCachedAccessToken };
    }),
  };
});

describe('initializeServerTelemetry', () => {
  beforeEach(() => {
    mocks.initializeTelemetry.mockClear();
    mocks.createKimiDeviceId.mockClear();
    mocks.getCachedAccessToken.mockClear();
    mocks.loadRuntimeConfigSafe.mockClear();
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    });
  });

  it('disables upstream telemetry for the web host without creating an identity or token', async () => {
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'batch-translating-cli',
        version: '1.2.3',
        uiMode: 'web',
        enabled: false,
        deviceId: 'telemetry-disabled',
        homeDir: '/home/.batch-translating',
      }),
    );
    const initOptions = mocks.initializeTelemetry.mock.calls[0]?.[0] as {
      readonly getAccessToken?: () => Promise<unknown>;
    };
    await expect(initOptions.getAccessToken?.()).resolves.toBeNull();
    expect(mocks.createKimiDeviceId).not.toHaveBeenCalled();
    expect(mocks.getCachedAccessToken).not.toHaveBeenCalled();
    // The returned client wraps the module functions so core + the host share
    // the same underlying client.
    expect(client).toEqual(
      expect.objectContaining({
        track: expect.any(Function),
        withContext: expect.any(Function),
        setContext: expect.any(Function),
      }),
    );
    // The first dynamic import pulls in the whole SDK/oauth chain and can take
    // close to 20s on a cold Windows worker. Full-suite transform contention
    // needs additional headroom; the assertions still verify the same result.
  }, 60000);

  it('disables telemetry when config.toml sets telemetry = false', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: false },
      fileError: undefined,
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('keeps telemetry disabled with no model when config is unreadable', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: {},
      fileError: new Error('bad toml'),
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
       appName: 'batch-translating-cli',
       deviceId: 'telemetry-disabled',
       enabled: false,
     }),
   );
   const initOptions = mocks.initializeTelemetry.mock.calls[0]?.[0] as {
      readonly model?: unknown;
     readonly getAccessToken?: () => Promise<unknown>;
   };
    expect(initOptions.model).toBeUndefined();
    await expect(initOptions.getAccessToken?.()).resolves.toBeNull();
    expect(mocks.createKimiDeviceId).not.toHaveBeenCalled();
    expect(mocks.getCachedAccessToken).not.toHaveBeenCalled();
  });
});
