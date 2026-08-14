<!-- apps/batch-translating-web/src/components/dialogs/EditProviderModelsDialog.vue -->
<!-- Per-provider model list editor: adjust each model's context window
     (max_context_size) and save through PUT /providers/{id}. -->
<script setup lang="ts">
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel, AppProvider } from '../../api/types';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  provider: AppProvider;
  models: AppModel[];
}>();

const emit = defineEmits<{
  save: [payload: {
    newId?: string;
    type: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    models: Array<{ model: string; maxContextSize: number }>;
  }];
  close: [];
}>();

/** Strip the `<provider>/` prefix from a wire alias id, keeping bare model
 *  names for the wire form (PUT /providers expects `models[].model` without
 *  the provider prefix, and `default_model` must match one of them). */
function bareName(aliasId: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return aliasId.startsWith(prefix) ? aliasId.slice(prefix.length) : aliasId;
}

const form = reactive<{
  type: string;
  baseUrl: string;
  defaultModel: string;
  models: Array<{ model: string; displayName: string; maxContextSize: number }>;
}>({
  type: props.provider.type,
  baseUrl: props.provider.baseUrl ?? '',
  // The stored default is the alias id `<provider>/<model>`; the wire form
  // wants the bare model name (the daemon re-derives the alias id).
  defaultModel: props.provider.defaultModel
    ? bareName(props.provider.defaultModel, props.provider.id)
    : '',
  models: props.models.map((model) => ({
    model: bareName(model.model, model.provider),
    displayName: model.displayName ?? model.model,
    maxContextSize: model.maxContextSize > 0 ? model.maxContextSize : 200_000,
  })),
});

function onSave(): void {
  const models = form.models.map((entry) => ({
    model: entry.model,
    maxContextSize: Math.max(1, Math.round(entry.maxContextSize)),
  }));
  emit('save', {
    type: form.type,
    baseUrl: form.baseUrl || undefined,
    defaultModel: form.defaultModel || undefined,
    models,
  });
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('providers.editModelsTitle', { id: provider.id })"
    size="lg"
    @close="emit('close')"
  >
    <div class="edit-models">
      <p class="edit-models__hint">
        {{ t('providers.editModelsHint') }}
      </p>

      <Field :label="t('providers.fieldBaseUrl')">
        <Input v-model="form.baseUrl" placeholder="https://…/v1" autocomplete="off" spellcheck="false" />
      </Field>

      <Field :label="t('providers.fieldDefaultModel')">
        <Input v-model="form.defaultModel" placeholder="默认模型" autocomplete="off" spellcheck="false" />
      </Field>

      <div class="edit-models__list">
        <div v-for="entry in form.models" :key="entry.model" class="edit-models__row">
          <span class="edit-models__name" :title="entry.model">{{ entry.displayName }}</span>
          <label class="edit-models__ctx">
            <span>{{ t('providers.contextLabel') }}</span>
            <Input
              v-model.number="entry.maxContextSize"
              type="number"
              min="1"
              step="1000"
              autocomplete="off"
            />
          </label>
        </div>
      </div>
    </div>

    <template #foot>
      <div class="dialog-actions">
        <Button variant="secondary" @click="emit('close')">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" @click="onSave">
          {{ t('common.save') }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.edit-models {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.edit-models__hint {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.edit-models__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 320px;
  overflow: auto;
}
.edit-models__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.edit-models__name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-models__ctx {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.edit-models__ctx :deep(input) {
  width: 130px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
</style>
