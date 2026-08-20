<!-- apps/batch-translating-web/src/components/dialogs/EditProviderModelsDialog.vue -->
<!-- Per-provider model editor: context window plus explicit per-token pricing. -->
<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel, AppProvider, ProviderModelConfigInput } from '../../api/types';
import Banner from '../ui/Banner.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';

const { t } = useI18n();

const modelCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

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
    models: ProviderModelConfigInput[];
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

type OptionalPriceInput = number | '';

const validationError = ref('');
const form = reactive<{
  type: string;
  baseUrl: string;
  defaultModel: string;
  models: Array<{
    model: string;
    displayName: string;
    maxContextSize: number;
    inputPrice: OptionalPriceInput;
    outputPrice: OptionalPriceInput;
    cacheReadPrice: OptionalPriceInput;
    cacheCreationPrice: OptionalPriceInput;
  }>;
}>({
  type: props.provider.type,
  baseUrl: props.provider.baseUrl ?? '',
  // The stored default is the alias id `<provider>/<model>`; the wire form
  // wants the bare model name (the daemon re-derives the alias id).
  defaultModel: props.provider.defaultModel
    ? bareName(props.provider.defaultModel, props.provider.id)
    : '',
  models: [...props.models]
    .sort((left, right) => modelCollator.compare(
      left.displayName ?? left.model,
      right.displayName ?? right.model,
    ) || modelCollator.compare(left.model, right.model))
    .map((model) => ({
      model: bareName(model.model, model.provider),
      displayName: model.displayName ?? model.model,
      maxContextSize: model.maxContextSize > 0 ? model.maxContextSize : 200_000,
      inputPrice: model.pricing?.inputUsdPerMillion ?? '',
      outputPrice: model.pricing?.outputUsdPerMillion ?? '',
      cacheReadPrice: model.pricing?.cacheReadUsdPerMillion ?? '',
      cacheCreationPrice: model.pricing?.cacheCreationUsdPerMillion ?? '',
    })),
});

function optionalPrice(value: OptionalPriceInput): number | undefined {
  if (value === '') return undefined;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function onSave(): void {
  validationError.value = '';
  const models: ProviderModelConfigInput[] = [];
  for (const entry of form.models) {
    const rawPrices = [
      entry.inputPrice,
      entry.outputPrice,
      entry.cacheReadPrice,
      entry.cacheCreationPrice,
    ];
    if (rawPrices.some((value) => value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0))) {
      validationError.value = t('providers.pricingInvalid', { model: entry.displayName });
      return;
    }
    const input = optionalPrice(entry.inputPrice);
    const output = optionalPrice(entry.outputPrice);
    const cacheRead = optionalPrice(entry.cacheReadPrice);
    const cacheCreation = optionalPrice(entry.cacheCreationPrice);
    const hasAnyPrice = [input, output, cacheRead, cacheCreation].some((price) => price !== undefined);
    if (hasAnyPrice && (input === undefined || output === undefined)) {
      validationError.value = t('providers.pricingPairRequired', { model: entry.displayName });
      return;
    }
    models.push({
      model: entry.model,
      maxContextSize: Math.max(1, Math.round(entry.maxContextSize)),
      ...(input === undefined || output === undefined ? { pricing: null } : {
        pricing: {
          currency: 'USD',
          inputUsdPerMillion: input,
          outputUsdPerMillion: output,
          ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillion: cacheRead }),
          ...(cacheCreation === undefined ? {} : { cacheCreationUsdPerMillion: cacheCreation }),
        },
      }),
    });
  }
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

      <Banner v-if="validationError" variant="danger">
        {{ validationError }}
      </Banner>

      <Field :label="t('providers.fieldBaseUrl')">
        <Input v-model="form.baseUrl" placeholder="https://…/v1" autocomplete="off" spellcheck="false" />
      </Field>

      <Field :label="t('providers.fieldDefaultModel')">
        <Input
          v-model="form.defaultModel"
          list="edit-provider-default-models"
          placeholder="默认模型"
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id="edit-provider-default-models">
          <option v-for="entry in form.models" :key="entry.model" :value="entry.model">
            {{ entry.displayName }}
          </option>
        </datalist>
      </Field>

      <div class="edit-models__pricing-section">
        <p class="edit-models__price-hint">{{ t('providers.pricingHint') }}</p>
        <div class="edit-models__list">
          <div v-for="entry in form.models" :key="entry.model" class="edit-models__row">
            <div class="edit-models__header">
              <span class="edit-models__name" :title="entry.model">{{ entry.displayName }}</span>
              <label class="edit-models__ctx">
                <span>{{ t('providers.contextLabel') }}</span>
                <Input
                  v-model.number="entry.maxContextSize"
                  size="sm"
                  type="number"
                  min="1"
                  step="1000"
                  autocomplete="off"
                />
              </label>
            </div>
            <div class="edit-models__pricing">
              <label>
                <span>{{ t('providers.inputPriceLabel') }}</span>
                <Input v-model.number="entry.inputPrice" size="sm" type="number" min="0" step="0.01" placeholder="—" />
              </label>
              <label>
                <span>{{ t('providers.outputPriceLabel') }}</span>
                <Input v-model.number="entry.outputPrice" size="sm" type="number" min="0" step="0.01" placeholder="—" />
              </label>
              <label>
                <span>{{ t('providers.cacheReadPriceLabel') }}</span>
                <Input v-model.number="entry.cacheReadPrice" size="sm" type="number" min="0" step="0.01" placeholder="—" />
              </label>
              <label>
                <span>{{ t('providers.cacheCreationPriceLabel') }}</span>
                <Input v-model.number="entry.cacheCreationPrice" size="sm" type="number" min="0" step="0.01" placeholder="—" />
              </label>
            </div>
          </div>
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
.edit-models__pricing-section {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-2);
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
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.edit-models__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
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
.edit-models__pricing {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
  width: 100%;
}
.edit-models__pricing label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.edit-models__price-hint {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
@media (max-width: 760px) {
  .edit-models__pricing {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
</style>
