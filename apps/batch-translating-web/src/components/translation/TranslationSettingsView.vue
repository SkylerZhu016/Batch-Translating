<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TranslationQualityPolicy } from '../../translation/qualityPolicy';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import Checkbox from '../ui/Checkbox.vue';
import Field from '../ui/Field.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import LanguageSwitcher from '../settings/LanguageSwitcher.vue';
import BgeModelSetup from './BgeModelSetup.vue';
import type {
  BgeModelDownloadSource,
  BgeModelSetupState,
} from './bgeModelSetup.types';
import type {
  TranslationExecutionPolicy,
  TranslationSettings,
  TranslationWorkflowOptions,
} from './types';

const MICROS_PER_BILLING_UNIT = 1_000_000;
const MAX_BUDGET_UNITS = Math.floor(Number.MAX_SAFE_INTEGER / MICROS_PER_BILLING_UNIT);

const props = withDefaults(defineProps<{
  modelValue: TranslationSettings;
  models: { value: string; label: string }[];
  saving?: boolean;
  bgeState?: BgeModelSetupState;
  qualityPolicy?: TranslationQualityPolicy;
}>(), {
  saving: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: TranslationSettings];
  'manage-models': [];
  save: [];
  'bge-detect': [];
  'bge-download': [];
  'bge-cancel': [];
  'bge-retry': [];
  'bge-verify': [];
  'bge-rebuild': [];
}>();

const { t } = useI18n();
const resolvedBgeState = computed<BgeModelSetupState>(() => props.bgeState ?? {
  status: 'missing',
});
const retrievalReady = computed(() => (
  props.qualityPolicy?.capability.retrievalUsable === true
));
const secondReviewLocked = computed(() => (
  !retrievalReady.value
  || props.qualityPolicy?.secondReviewControl.userCanDisable !== true
));
const effectiveSecondReview = computed(() => (
  secondReviewLocked.value || props.modelValue.defaultWorkflow.secondReview
));

function updateField<K extends keyof TranslationSettings>(key: K, value: TranslationSettings[K]): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateWorkflow<K extends keyof TranslationWorkflowOptions>(
  key: K,
  value: TranslationWorkflowOptions[K],
): void {
  if (key === 'secondReview' && secondReviewLocked.value) return;
  updateField('defaultWorkflow', { ...props.modelValue.defaultWorkflow, [key]: value });
}

function updateBgeSource(source: BgeModelDownloadSource): void {
  updateField('bge', {
    ...(props.modelValue.bge ?? { source: 'mirror', cpuFallback: true }),
    source,
  });
}

function updateBgeCpuFallback(cpuFallback: boolean): void {
  updateField('bge', {
    ...(props.modelValue.bge ?? { source: 'mirror', cpuFallback: true }),
    cpuFallback,
  });
}

function budgetUnits(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) return 0;
  return micros / MICROS_PER_BILLING_UNIT;
}

function updateBudget(
  key: 'softBudgetMicros' | 'hardBudgetMicros',
  rawValue: string,
): void {
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) return;
  const micros = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round(Math.max(0, parsed) * MICROS_PER_BILLING_UNIT),
  );
  const current = props.modelValue.executionPolicy;
  const next: TranslationExecutionPolicy = { ...current, [key]: micros };
  if (key === 'softBudgetMicros' && next.hardBudgetMicros < micros) {
    next.hardBudgetMicros = micros;
  }
  if (key === 'hardBudgetMicros' && next.softBudgetMicros > micros) {
    next.softBudgetMicros = micros;
  }
  updateField('executionPolicy', next);
}

function updateExecutionInteger(
  key: 'maxRetries' | 'maxConcurrency',
  rawValue: string,
): void {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) return;
  const minimum = key === 'maxRetries' ? 0 : 1;
  const maximum = key === 'maxRetries' ? 20 : 128;
  updateField('executionPolicy', {
    ...props.modelValue.executionPolicy,
    [key]: Math.min(maximum, Math.max(minimum, parsed)),
  });
}

function updateAgentCount(value: string): void {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return;
  updateField('defaultAgentCount', Math.min(128, Math.max(2, parsed)));
}

watch(
  [secondReviewLocked, () => props.modelValue.defaultWorkflow.secondReview],
  ([locked, enabled]) => {
    if (!locked || enabled) return;
    updateField('defaultWorkflow', {
      ...props.modelValue.defaultWorkflow,
      secondReview: true,
    });
  },
  { immediate: true, flush: 'post' },
);
</script>

<template>
  <section class="settings-view">
    <header class="settings-view__header">
      <div>
        <h1>{{ t('translation.settings.title') }}</h1>
        <p>{{ t('translation.settings.subtitle') }}</p>
      </div>
      <Button :loading="saving" @click="emit('save')">
        {{ t('translation.settings.save') }}
      </Button>
    </header>

    <div class="settings-view__content">
      <Card>
        <template #head>
          {{ t('translation.settings.languageTitle') }}
        </template>
        <div class="settings-view__locale">
          <div class="settings-view__locale-copy">
            <span class="settings-view__locale-label">{{ t('translation.settings.languageTitle') }}</span>
            <span class="settings-view__locale-hint">{{ t('translation.settings.languageHint') }}</span>
          </div>
          <LanguageSwitcher :aria-label="t('translation.settings.languageTitle')" />
        </div>
      </Card>

      <Card>
        <template #head>
          <Icon name="settings" size="md" />
          {{ t('translation.settings.executionPolicy.title') }}
        </template>
        <p class="settings-view__section-hint">
          {{ t('translation.settings.executionPolicy.hint') }}
        </p>
        <div class="settings-view__execution-grid">
          <Field
            :label="t('translation.settings.executionPolicy.softBudget')"
            :hint="t('translation.settings.executionPolicy.softBudgetHint')"
          >
            <Input
              :model-value="budgetUnits(modelValue.executionPolicy.softBudgetMicros)"
              type="number"
              min="0"
              :max="MAX_BUDGET_UNITS"
              step="0.01"
              @update:model-value="updateBudget('softBudgetMicros', String($event))"
            />
          </Field>
          <Field
            :label="t('translation.settings.executionPolicy.hardBudget')"
            :hint="t('translation.settings.executionPolicy.hardBudgetHint')"
          >
            <Input
              :model-value="budgetUnits(modelValue.executionPolicy.hardBudgetMicros)"
              type="number"
              min="0"
              :max="MAX_BUDGET_UNITS"
              step="0.01"
              @update:model-value="updateBudget('hardBudgetMicros', String($event))"
            />
          </Field>
          <Field
            :label="t('translation.settings.executionPolicy.maxRetries')"
            :hint="t('translation.settings.executionPolicy.maxRetriesHint')"
          >
            <Input
              :model-value="modelValue.executionPolicy.maxRetries"
              type="number"
              min="0"
              max="20"
              step="1"
              @update:model-value="updateExecutionInteger('maxRetries', String($event))"
            />
          </Field>
          <Field
            :label="t('translation.settings.executionPolicy.maxConcurrency')"
            :hint="t('translation.settings.executionPolicy.maxConcurrencyHint')"
          >
            <Input
              :model-value="modelValue.executionPolicy.maxConcurrency"
              type="number"
              min="1"
              max="128"
              step="1"
              @update:model-value="updateExecutionInteger('maxConcurrency', String($event))"
            />
          </Field>
        </div>
      </Card>

      <BgeModelSetup
        v-bind="resolvedBgeState"
        :source="modelValue.bge?.source ?? 'mirror'"
        :cpu-fallback-enabled="modelValue.bge?.cpuFallback ?? true"
        @update:source="updateBgeSource"
        @update:cpu-fallback-enabled="updateBgeCpuFallback"
        @detect="emit('bge-detect')"
        @download="emit('bge-download')"
        @cancel="emit('bge-cancel')"
        @retry="emit('bge-retry')"
        @verify="emit('bge-verify')"
        @rebuild="emit('bge-rebuild')"
      />

      <Card>
        <template #head>
          <Icon name="sliders" size="md" />
          {{ t('translation.settings.defaultsTitle') }}
        </template>
        <div class="settings-view__form">
          <div class="settings-view__row">
            <Field class="settings-view__grow" :label="t('translation.settings.defaultModel')">
              <Select
                :model-value="modelValue.defaultModel"
                @update:model-value="updateField('defaultModel', $event)"
              >
                <option v-for="model in models" :key="model.value" :value="model.value">
                  {{ model.label }}
                </option>
              </Select>
            </Field>
            <Button variant="secondary" @click="emit('manage-models')">
              {{ t('translation.settings.manageModels') }}
            </Button>
          </div>

          <Field
            class="settings-view__agents"
            :label="t('translation.settings.defaultAgents')"
            :hint="t('translation.settings.defaultAgentsHint')"
          >
            <Input
              :model-value="modelValue.defaultAgentCount"
              type="number"
              min="2"
              max="128"
              step="1"
              @update:model-value="updateAgentCount(String($event))"
            />
          </Field>
        </div>
      </Card>

      <Card>
        <template #head>
          <Icon name="check-list" size="md" />
          {{ t('translation.settings.workflowTitle') }}
        </template>
        <p class="settings-view__section-hint">{{ t('translation.settings.workflowHint') }}</p>
        <div class="settings-view__workflow">
          <div class="settings-view__workflow-item is-required">
            <Checkbox :model-value="true" disabled>{{ t('translation.create.firstTranslation') }}</Checkbox>
            <span>{{ t('translation.create.firstTranslationHint') }}</span>
          </div>
          <div class="settings-view__workflow-item is-required">
            <Checkbox :model-value="true" disabled>{{ t('translation.create.firstReview') }}</Checkbox>
            <span>{{ t('translation.create.firstReviewHint') }}</span>
          </div>
          <div class="settings-view__workflow-item">
            <Checkbox
              :model-value="modelValue.defaultWorkflow.secondTranslation"
              @update:model-value="updateWorkflow('secondTranslation', $event)"
            >
              {{ t('translation.create.secondTranslation') }}
            </Checkbox>
            <span>{{ t('translation.create.secondTranslationHint') }}</span>
          </div>
          <div
            class="settings-view__workflow-item"
            :class="{ 'is-required': secondReviewLocked }"
          >
            <Checkbox
              :model-value="effectiveSecondReview"
              :disabled="secondReviewLocked"
              @update:model-value="updateWorkflow('secondReview', $event)"
            >
              {{ t('translation.create.secondReview') }}
            </Checkbox>
            <span v-if="secondReviewLocked" class="settings-view__quality-lock">
              {{ t('translation.settings.qualityFallback.secondReviewLocked') }}
            </span>
            <span v-else>{{ t('translation.create.secondReviewHint') }}</span>
          </div>
          <div class="settings-view__workflow-item">
            <Checkbox
              :model-value="modelValue.defaultWorkflow.consistencyReview"
              @update:model-value="updateWorkflow('consistencyReview', $event)"
            >
              {{ t('translation.create.consistencyReview') }}
            </Checkbox>
            <span>{{ t('translation.create.consistencyReviewHint') }}</span>
          </div>
        </div>
      </Card>

      <Card>
        <template #head>
          <Icon name="tool" size="md" />
          {{ t('translation.settings.toolsTitle') }}
        </template>
        <p class="settings-view__section-hint">{{ t('translation.settings.toolsHint') }}</p>
        <div class="settings-view__tools">
          <div class="settings-view__tool">
            <Icon name="file" size="md" />
            <Checkbox :model-value="true" disabled>{{ t('translation.settings.tools.read') }}</Checkbox>
          </div>
          <div class="settings-view__tool">
            <Icon name="file-edit" size="md" />
            <Checkbox :model-value="true" disabled>{{ t('translation.settings.tools.write') }}</Checkbox>
          </div>
          <div class="settings-view__tool">
            <Icon name="terminal" size="md" />
            <Checkbox :model-value="true" disabled>{{ t('translation.settings.tools.bash') }}</Checkbox>
          </div>
          <div class="settings-view__tool">
            <Icon name="git-fork" size="md" />
            <Checkbox :model-value="true" disabled>{{ t('translation.settings.tools.agentSwarm') }}</Checkbox>
          </div>
        </div>
      </Card>

      <Card v-if="$slots.appearance">
        <template #head>
          <Icon name="sparkles" size="md" />
          {{ t('translation.settings.appearanceTitle') }}
        </template>
        <slot name="appearance" />
      </Card>

      <Card v-if="$slots.advanced">
        <template #head>
          <Icon name="settings" size="md" />
          {{ t('translation.settings.advancedTitle') }}
        </template>
        <slot name="advanced" />
      </Card>
    </div>
  </section>
</template>

<style scoped>
.settings-view {
  height: 100%;
  padding: var(--space-6);
  overflow-y: auto;
}

.settings-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--p-content-wide);
  margin: 0 auto var(--space-6);
}

.settings-view__header h1 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.settings-view__header p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}

.settings-view__content {
  display: flex;
  width: 100%;
  max-width: var(--p-content-wide);
  flex-direction: column;
  gap: var(--space-4);
  margin: 0 auto;
}

.settings-view__locale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.settings-view__locale-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.settings-view__locale-label {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.settings-view__locale-hint {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.settings-view__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.settings-view__row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
}

.settings-view__grow {
  min-width: 0;
  flex: 1;
}

.settings-view__agents {
  width: calc(var(--space-8) * 4);
}

.settings-view__execution-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.settings-view__section-hint {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.settings-view__workflow {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.settings-view__workflow-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.settings-view__workflow-item.is-required {
  background: var(--color-surface-sunken);
}

.settings-view__workflow-item > span {
  padding-left: calc(17px + var(--space-2));
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.settings-view__tools {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.settings-view__tool {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}

@media (max-width: 640px) {
  .settings-view {
    padding: var(--space-4);
  }

  .settings-view__header,
  .settings-view__row {
    align-items: stretch;
    flex-direction: column;
  }

  .settings-view__locale {
    align-items: stretch;
    flex-direction: column;
  }

  .settings-view__agents {
    width: 100%;
  }

  .settings-view__workflow {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-view__execution-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-view__tools {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
