// apps/batch-translating-web/src/composables/client/useAppearance.ts
// Appearance preferences (color scheme / paired day and night palettes /
// font family / accent / UI font size) and the
// streaming "fast moon" spinner state. Pure local UI state: only touches
// storage + the DOM, never rawState or the API. The values are module-level
// singletons so the whole app shares one instance.

import { ref, watch } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';

/** Color scheme: 'light', 'dark', or follow the OS preference ('system'). */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Accent: 'blue' (Kimi blue, default) or 'mono' (black/white). */
export type Accent = 'blue' | 'mono';

/** Palette used whenever the effective color scheme is light. */
export type DayTheme = 'pure-white' | 'maple';

/** Palette used whenever the effective color scheme is dark. */
export type NightTheme = 'ink-black' | 'ink-blue';

/** Bundled literary face or the current operating-system UI stack. */
export type UiFont = 'wenkai' | 'system';

const ACCENT_VALUES: readonly string[] = ['blue', 'mono'];
const COLOR_SCHEME_VALUES: readonly string[] = ['light', 'dark', 'system'];
const DAY_THEME_VALUES: readonly string[] = ['pure-white', 'maple'];
const NIGHT_THEME_VALUES: readonly string[] = ['ink-black', 'ink-blue'];
const UI_FONT_VALUES: readonly string[] = ['wenkai', 'system'];
const UI_FONT_SIZE_DEFAULT = 14;
const UI_FONT_SIZE_MIN = 12;
const UI_FONT_SIZE_MAX = 20;

const DAY_THEME_COLOR: Record<DayTheme, string> = {
  'pure-white': '#ffffff',
  maple: '#fffaf3',
};

const NIGHT_THEME_COLOR: Record<NightTheme, string> = {
  'ink-black': '#101113',
  'ink-blue': '#0b1120',
};

function loadAccent(): Accent {
  const v = safeGetString(STORAGE_KEYS.accent);
  if (v && ACCENT_VALUES.includes(v)) return v as Accent;
  return 'blue';
}

function applyAccent(a: Accent): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.accent = a;
}

function loadColorScheme(): ColorScheme {
  const v = safeGetString(STORAGE_KEYS.colorScheme);
  if (v && COLOR_SCHEME_VALUES.includes(v)) return v as ColorScheme;
  return 'system';
}

function applyColorScheme(c: ColorScheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.colorScheme = c;
}

function loadDayTheme(): DayTheme {
  const v = safeGetString(STORAGE_KEYS.dayTheme);
  if (v && DAY_THEME_VALUES.includes(v)) return v as DayTheme;
  return 'maple';
}

function applyDayTheme(theme: DayTheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.dayTheme = theme;
}

function loadNightTheme(): NightTheme {
  const v = safeGetString(STORAGE_KEYS.nightTheme);
  if (v && NIGHT_THEME_VALUES.includes(v)) return v as NightTheme;
  return 'ink-blue';
}

function applyNightTheme(theme: NightTheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.nightTheme = theme;
}

function loadUiFont(): UiFont {
  const v = safeGetString(STORAGE_KEYS.uiFont);
  if (v && UI_FONT_VALUES.includes(v)) return v as UiFont;
  return 'wenkai';
}

function applyUiFont(font: UiFont): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.dataset.uiFont = font;
}

function applyThemeColorMeta(
  scheme: ColorScheme,
  selectedDayTheme: DayTheme,
  selectedNightTheme: NightTheme,
): void {
  if (typeof document === 'undefined') return;

  // Mobile browser chrome (status/address bar) follows <meta name=theme-color>.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) return;
  const dayColor = DAY_THEME_COLOR[selectedDayTheme];
  const nightColor = NIGHT_THEME_COLOR[selectedNightTheme];
  const pinned = scheme === 'dark' ? nightColor : scheme === 'light' ? dayColor : null;
  metas.forEach((meta) => {
    const media = meta.getAttribute('media') ?? '';
    const systemValue = media.includes('dark') ? nightColor : dayColor;
    meta.setAttribute('content', pinned ?? systemValue);
  });
}

function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_DEFAULT;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(value)));
}

function loadUiFontSize(): number {
  const v = safeGetString(STORAGE_KEYS.uiFontSize);
  return v === null ? UI_FONT_SIZE_DEFAULT : clampUiFontSize(Number(v));
}

function applyUiFontSize(value: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.style.setProperty('--base-ui-font-size', `${clampUiFontSize(value)}px`);
}

const colorScheme = ref<ColorScheme>(loadColorScheme());
const accent = ref<Accent>(loadAccent());
const dayTheme = ref<DayTheme>(loadDayTheme());
const nightTheme = ref<NightTheme>(loadNightTheme());
const uiFont = ref<UiFont>(loadUiFont());
const uiFontSize = ref<number>(loadUiFontSize());

watch(colorScheme, applyColorScheme, { immediate: true });
watch(accent, applyAccent, { immediate: true });
watch(dayTheme, applyDayTheme, { immediate: true });
watch(nightTheme, applyNightTheme, { immediate: true });
watch(uiFont, applyUiFont, { immediate: true });
watch(
  [colorScheme, dayTheme, nightTheme] as const,
  ([scheme, selectedDayTheme, selectedNightTheme]) => {
    applyThemeColorMeta(scheme, selectedDayTheme, selectedNightTheme);
  },
  { immediate: true },
);
watch(uiFontSize, applyUiFontSize, { immediate: true });

function setColorScheme(c: ColorScheme): void {
  if (!COLOR_SCHEME_VALUES.includes(c)) return;
  colorScheme.value = c;
  safeSetString(STORAGE_KEYS.colorScheme, c);
}

function setAccent(a: Accent): void {
  if (!ACCENT_VALUES.includes(a)) return;
  accent.value = a;
  safeSetString(STORAGE_KEYS.accent, a);
}

function setDayTheme(theme: DayTheme): void {
  if (!DAY_THEME_VALUES.includes(theme)) return;
  dayTheme.value = theme;
  safeSetString(STORAGE_KEYS.dayTheme, theme);
}

function setNightTheme(theme: NightTheme): void {
  if (!NIGHT_THEME_VALUES.includes(theme)) return;
  nightTheme.value = theme;
  safeSetString(STORAGE_KEYS.nightTheme, theme);
}

function setUiFont(font: UiFont): void {
  if (!UI_FONT_VALUES.includes(font)) return;
  uiFont.value = font;
  safeSetString(STORAGE_KEYS.uiFont, font);
}

function setUiFontSize(value: number): void {
  const next = clampUiFontSize(value);
  uiFontSize.value = next;
  safeSetString(STORAGE_KEYS.uiFontSize, String(next));
}

// CSS handles the moon frames; this only flips the spinner between normal and
// fast classes when the active session is visibly producing content quickly.
const MOON_FAST_WINDOW_MS = 600;
const MOON_FAST_MIN_ELAPSED_MS = 250;
const MOON_FAST_CHECK_INTERVAL_MS = 250;
const MOON_FAST_HOLD_MS = 1000;
const MOON_FAST_CHARS_PER_SECOND = 160;

type MoonSpeedSample = { time: number; chars: number };

const fastMoon = ref(false);
let moonSpeedSamples: MoonSpeedSample[] = [];
let moonFastResetTimer: ReturnType<typeof setTimeout> | null = null;
let lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;

function resetFastMoon(): void {
  moonSpeedSamples = [];
  lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;
  fastMoon.value = false;
  if (moonFastResetTimer !== null) {
    clearTimeout(moonFastResetTimer);
    moonFastResetTimer = null;
  }
}

function holdFastMoon(): void {
  fastMoon.value = true;
  if (moonFastResetTimer !== null) clearTimeout(moonFastResetTimer);
  moonFastResetTimer = setTimeout(() => {
    moonFastResetTimer = null;
    moonSpeedSamples = [];
    lastMoonFastCheckAt = -MOON_FAST_CHECK_INTERVAL_MS;
    fastMoon.value = false;
  }, MOON_FAST_HOLD_MS);
}

function recordMoonDelta(chars: number): void {
  if (chars <= 0) return;
  const now = Date.now();
  moonSpeedSamples.push({ time: now, chars });
  const cutoff = now - MOON_FAST_WINDOW_MS;
  moonSpeedSamples = moonSpeedSamples.filter((s) => s.time >= cutoff);

  if (now - lastMoonFastCheckAt < MOON_FAST_CHECK_INTERVAL_MS) return;
  lastMoonFastCheckAt = now;

  const oldest = moonSpeedSamples[0]?.time ?? now;
  const elapsed = Math.max(now - oldest, MOON_FAST_MIN_ELAPSED_MS);
  const totalChars = moonSpeedSamples.reduce((sum, s) => sum + s.chars, 0);
  const charsPerSecond = (totalChars / elapsed) * 1000;
  if (charsPerSecond >= MOON_FAST_CHARS_PER_SECOND) holdFastMoon();
}

export function useAppearance() {
  return {
    colorScheme,
    accent,
    dayTheme,
    nightTheme,
    uiFont,
    uiFontSize,
    fastMoon,
    setColorScheme,
    setAccent,
    setDayTheme,
    setNightTheme,
    setUiFont,
    setUiFontSize,
    resetFastMoon,
    recordMoonDelta,
  };
}
