<!-- apps/batch-translating-web/src/components/dialogs/ExitAppDialog.vue -->
<!-- Confirm-exit dialog: warns that quitting stops the engine (and any running
     translation jobs), with an optional "don't ask again" checkbox. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from '../ui/Button.vue';
import Checkbox from '../ui/Checkbox.vue';
import Dialog from '../ui/Dialog.vue';
import Icon from '../ui/Icon.vue';

const { t } = useI18n();

defineProps<{ open: boolean }>();

const emit = defineEmits<{
  confirm: [dontAskAgain: boolean];
  close: [];
}>();

const dontAskAgain = ref(false);
</script>

<template>
  <Dialog :open="open" :title="t('translation.exit.title')" size="md" @close="emit('close')">
    <div class="exit-dialog">
      <div class="exit-dialog__body">
        <span class="exit-dialog__icon" aria-hidden="true">
          <Icon name="alert-triangle" size="lg" />
        </span>
        <div class="exit-dialog__copy">
          <p>{{ t('translation.exit.message') }}</p>
          <p class="exit-dialog__hint">{{ t('translation.exit.hint') }}</p>
        </div>
      </div>

      <label class="exit-dialog__no-prompt">
        <Checkbox v-model="dontAskAgain" />
        <span>{{ t('translation.exit.dontAskAgain') }}</span>
      </label>
    </div>

    <template #foot>
      <div class="dialog-actions">
        <Button variant="secondary" @click="emit('close')">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" @click="emit('confirm', dontAskAgain)">
          {{ t('translation.exit.confirm') }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.exit-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.exit-dialog__body {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.exit-dialog__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
}
.exit-dialog__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.exit-dialog__copy p {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.exit-dialog__hint {
  font-size: var(--text-sm) !important;
  color: var(--color-text-muted) !important;
}
.exit-dialog__no-prompt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  user-select: none;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
</style>
