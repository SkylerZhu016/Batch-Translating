/**
 * Normalize the provider base exactly the same way the OpenAI-compatible
 * runtime does. This keeps the address tested by onboarding and the address
 * saved for real chat requests on one contract.
 */
export function normalizeProviderBaseUrl(
  providerType: string,
  baseUrl: string | undefined,
): string | undefined {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '');
  if (!trimmed || providerType !== 'openai') return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
      return `${parsed.origin}/v1`;
    }
  } catch {
    // Let the connection request surface the malformed URL to the user.
  }
  return trimmed;
}

export function providerModelsUrl(providerType: string, baseUrl: string | undefined): string {
  const normalized = normalizeProviderBaseUrl(providerType, baseUrl);
  if (normalized) {
    if (normalized.endsWith('/models')) return normalized;
    if (providerType === 'openai' || normalized.endsWith('/v1')) {
      return `${normalized}/models`;
    }
    if (providerType === 'google-genai') return `${normalized}/v1beta/models`;
    return `${normalized}/v1/models`;
  }
  if (providerType === 'anthropic') return 'https://api.anthropic.com/v1/models';
  if (providerType === 'google-genai') {
    return 'https://generativelanguage.googleapis.com/v1beta/models';
  }
  return 'https://api.openai.com/v1/models';
}
