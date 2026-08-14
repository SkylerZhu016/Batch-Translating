/**
 * Minimal terminal color palette for the web server's console output.
 *
 * Values match the dark theme of the removed interactive TUI so `kimi web`
 * device-code / startup messages keep the same look.
 */
export const darkColors = {
  /** Dominant interactive/brand colour. */
  primary: '#4FA8FF',
  /** Secondary highlight (device-code box accents). */
  accent: '#5BC0BE',
  /** Secondary, dimmed text. */
  textDim: '#888888',
  /** Faintest text. */
  textMuted: '#6B6B6B',
  /** Error text. */
  error: '#E85454',
} as const;
