import { describe, expect, it } from 'vitest';
import { normalizeProviderBaseUrl, providerModelsUrl } from './providerBaseUrl';

describe('provider base URL normalization', () => {
  it('uses the same /v1 base for model discovery and OpenAI chat', () => {
    expect(normalizeProviderBaseUrl('openai', 'https://gateway.example')).toBe(
      'https://gateway.example/v1',
    );
    expect(providerModelsUrl('openai', 'https://gateway.example')).toBe(
      'https://gateway.example/v1/models',
    );
  });

  it('does not insert /v1 into an explicit custom path', () => {
    expect(normalizeProviderBaseUrl('openai', 'https://gateway.example/openai/')).toBe(
      'https://gateway.example/openai',
    );
  });
});
