<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import Dialog from '../ui/Dialog.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

const emit = defineEmits<{
  complete: [];
}>();

const { t, locale } = useI18n();
const options = availableLocales.map((item) => ({ value: item.code, label: item.label }));

function choose(code: string): void {
  const next = code as LocaleCode;
  setLocale(next);
  emit('complete');
}
</script>

<template>
  <Dialog
    :open="true"
    :close-on-overlay="false"
    :close-on-esc="false"
    :aria-label="t('translation.languageSelection.ariaLabel')"
    :padded="true"
    size="md"
    :initial-focus="'.ui-seg__item.is-on'"
  >
    <div class="lang-select">
      <div class="lang-select__copy">
        <div class="lang-select__title">{{ t('translation.languageSelection.titlePrimary') }}</div>
        <div class="lang-select__title lang-select__title--secondary">
          {{ t('translation.languageSelection.titleSecondary') }}
        </div>
        <p class="lang-select__hint">{{ t('translation.languageSelection.hint') }}</p>
      </div>

      <SegmentedControl
        :model-value="locale"
        :options="options"
        :aria-label="t('translation.languageSelection.ariaLabel')"
        @update:model-value="choose"
      />
    </div>
  </Dialog>
</template>

<style scoped>
.lang-select {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-2) 0 var(--space-1);
  text-align: center;
}

.lang-select__copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.lang-select__title {
  color: var(--color-text);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.lang-select__title--secondary {
  color: var(--color-text-muted);
  font-size: var(--text-lg);
}

.lang-select__hint {
  max-width: 28ch;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
</style>
