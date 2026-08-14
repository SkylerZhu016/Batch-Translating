<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import Kbd from '../ui/Kbd.vue';
import Pill from '../ui/Pill.vue';
import Textarea from '../ui/Textarea.vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  model?: string;
  busy?: boolean;
}>(), {
  model: '',
  busy: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send: [];
}>();

const { t } = useI18n();
const canSend = computed(() => props.modelValue.trim().length > 0 && !props.busy);

function onKeydown(event: KeyboardEvent): void {
  if (
    event.key !== 'Enter'
    || event.shiftKey
    || event.isComposing
    || event.keyCode === 229
  ) return;
  event.preventDefault();
  if (canSend.value) emit('send');
}
</script>

<template>
  <section class="correction-composer" :aria-label="t('translation.run.commandTitle')">
    <Textarea
      class="correction-composer__input"
      :model-value="modelValue"
      :placeholder="t('translation.run.commandPlaceholder')"
      :disabled="busy"
      :rows="2"
      @update:model-value="emit('update:modelValue', $event)"
      @keydown="onKeydown"
    />
    <footer class="correction-composer__bar">
      <span class="correction-composer__hint">
        {{ t('translation.run.commandHint') }}
        <Kbd :keys="[t('translation.run.commandEnter')]" />
        <Kbd :keys="[t('translation.run.commandModifier')]" />
      </span>
      <div class="correction-composer__actions">
        <Pill v-if="model" :clickable="false">{{ model }}</Pill>
        <Button size="sm" :loading="busy" :disabled="!canSend" @click="emit('send')">
          <Icon name="send" size="sm" />
          {{ t('translation.run.sendCommand') }}
        </Button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.correction-composer {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}

.correction-composer:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-sm), var(--p-focus-ring);
}

.correction-composer__input {
  min-height: calc(var(--space-8) * 2);
  max-height: calc(var(--space-8) * 3);
  border: 0;
  border-radius: 0;
  box-shadow: none;
  resize: none;
}

.correction-composer__input:focus {
  border-color: transparent;
  box-shadow: none;
}

.correction-composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2);
  border-top: 1px solid var(--color-line);
}

.correction-composer__hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.correction-composer__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 640px) {
  .correction-composer__hint {
    display: none;
  }

  .correction-composer__bar {
    justify-content: flex-end;
  }
}
</style>
