import { ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { messages } from './locales';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

export const availableLocales = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
] as const;

export type LocaleCode = (typeof availableLocales)[number]['code'];

function detect(): LocaleCode {
  const stored = safeGetString(STORAGE_KEYS.locale);
  if (stored === 'en' || stored === 'zh') return stored;
  return globalThis.navigator?.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function applyDocumentLocale(locale: LocaleCode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }
}

const initialLocale = detect();
applyDocumentLocale(initialLocale);

export const localeConfirmed = ref(safeGetString(STORAGE_KEYS.localeConfirmed) === '1');

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  messages,
});

export function setLocale(l: LocaleCode): void {
  i18n.global.locale.value = l;
  applyDocumentLocale(l);
  safeSetString(STORAGE_KEYS.locale, l);
  localeConfirmed.value = true;
  safeSetString(STORAGE_KEYS.localeConfirmed, '1');
}

export default i18n;
