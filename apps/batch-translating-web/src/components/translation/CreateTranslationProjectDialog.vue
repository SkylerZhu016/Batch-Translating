<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TranslationQualityPolicy } from '../../translation/qualityPolicy';
import Banner from '../ui/Banner.vue';
import Button from '../ui/Button.vue';
import Checkbox from '../ui/Checkbox.vue';
import Dialog from '../ui/Dialog.vue';
import Field from '../ui/Field.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import type { TranslationProjectDraft, TranslationWorkflowOptions } from './types';

const props = withDefaults(defineProps<{
  open: boolean;
  modelValue: TranslationProjectDraft;
  saving?: boolean;
  error?: string;
  /** Omitted/unknown capability probes deliberately fail closed. */
  qualityPolicy?: TranslationQualityPolicy;
}>(), {
  saving: false,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:modelValue': [value: TranslationProjectDraft];
  'source-file': [file: File];
  'source-path': [path: string];
  'choose-workspace': [];
  'setup-bge': [];
  create: [];
}>();

const { locale, t } = useI18n();
const sourceInput = ref<HTMLInputElement | null>(null);

const retrievalReady = computed(
  () => props.qualityPolicy?.capability.retrievalUsable === true,
);
const secondReviewForced = computed(() => !retrievalReady.value);
const effectiveSecondReview = computed(
  () => secondReviewForced.value || props.modelValue.workflow.secondReview,
);
const policyLocale = computed<'zhCN' | 'en'>(() => (
  locale.value.toLowerCase().startsWith('zh') ? 'zhCN' : 'en'
));
const fallbackNotice = computed(() => policyLocale.value === 'zhCN'
  ? '未检测到可用的 BGE-M3/RAG。为了保证翻译质量，本任务会强制执行第二轮独立审校与随后修复，这会增加模型调用、耗时和成本。建议先在设置中下载并启用 BGE-M3（GPU 加速建议约 4 GB 可用显存，也可使用较慢的 CPU 模式）。'
  : 'BGE-M3/RAG is not ready. To protect translation quality, this task must run a second independent review and repair, which increases model calls, time, and cost. Install and enable BGE-M3 in Settings first (GPU acceleration recommends about 4 GB of available VRAM; slower CPU fallback is supported).');
const qualityNotice = computed(() => props.qualityPolicy
  ? props.qualityPolicy.notices.cost[policyLocale.value]
  : fallbackNotice.value);
const setupBgeLabel = computed(() => policyLocale.value === 'zhCN'
  ? '前往设置下载 BGE-M3'
  : 'Download BGE-M3 in Settings');

const canCreate = computed(() => Boolean(
  props.modelValue.sourcePath.trim()
  && props.modelValue.workspacePath.trim()
  && props.modelValue.sourceLanguage.trim()
  && props.modelValue.sourceLanguage !== props.modelValue.targetLanguage
  && props.modelValue.agentCount >= 2
  && props.modelValue.agentCount <= 128
  && Number.isSafeInteger(props.modelValue.executionPolicy.softBudgetMicros)
  && props.modelValue.executionPolicy.softBudgetMicros >= 0
  && Number.isSafeInteger(props.modelValue.executionPolicy.hardBudgetMicros)
  && props.modelValue.executionPolicy.hardBudgetMicros
    >= props.modelValue.executionPolicy.softBudgetMicros
  && Number.isSafeInteger(props.modelValue.executionPolicy.maxRetries)
  && props.modelValue.executionPolicy.maxRetries >= 0
  && Number.isSafeInteger(props.modelValue.executionPolicy.maxConcurrency)
  && props.modelValue.executionPolicy.maxConcurrency >= 1
  && props.modelValue.executionPolicy.maxConcurrency <= props.modelValue.agentCount,
));

function updateField<K extends keyof TranslationProjectDraft>(
  key: K,
  value: TranslationProjectDraft[K],
): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function updateWorkflow<K extends keyof TranslationWorkflowOptions>(
  key: K,
  value: TranslationWorkflowOptions[K],
): void {
  if (key === 'secondReview' && secondReviewForced.value) return;
  updateField('workflow', { ...props.modelValue.workflow, [key]: value });
}

watch(
  [secondReviewForced, () => props.modelValue.workflow.secondReview],
  ([forced, selected]) => {
    if (!forced || selected) return;
    updateField('workflow', { ...props.modelValue.workflow, secondReview: true });
  },
  { immediate: true },
);

function updateAgentCount(value: string): void {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return;
  const agentCount = Math.min(128, Math.max(2, parsed));
  emit('update:modelValue', {
    ...props.modelValue,
    agentCount,
    executionPolicy: {
      ...props.modelValue.executionPolicy,
      maxConcurrency: Math.min(agentCount, props.modelValue.executionPolicy.maxConcurrency),
    },
  });
}

function updateTargetLanguage(value: string): void {
  if (value !== 'zh-CN' && value !== 'en') return;
  updateField('targetLanguage', value);
}

function budgetUsd(micros: number): number {
  return Number((micros / 1_000_000).toFixed(2));
}

function updateBudget(
  key: 'softBudgetMicros' | 'hardBudgetMicros',
  value: string,
): void {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return;
  const micros = Math.max(0, Math.round(parsed * 1_000_000));
  const policy = { ...props.modelValue.executionPolicy, [key]: micros };
  if (key === 'softBudgetMicros' && policy.hardBudgetMicros < micros) {
    policy.hardBudgetMicros = micros;
  } else if (key === 'hardBudgetMicros' && micros < policy.softBudgetMicros) {
    policy.hardBudgetMicros = policy.softBudgetMicros;
  }
  updateField('executionPolicy', policy);
}

function updatePolicyInteger(
  key: 'maxRetries' | 'maxConcurrency',
  value: string,
): void {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return;
  const next = key === 'maxRetries'
    ? Math.min(20, Math.max(0, parsed))
    : Math.min(props.modelValue.agentCount, Math.max(1, parsed));
  updateField('executionPolicy', { ...props.modelValue.executionPolicy, [key]: next });
}

function pickSource(): void {
  sourceInput.value?.click();
}

function onSourceFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  emit('update:modelValue', {
    ...props.modelValue,
    sourcePath: file.name,
    title: props.modelValue.title.trim() || file.name.replace(/\.(epub|txt)$/i, ''),
  });
  emit('source-file', file);
  input.value = '';
}

const isTxtSource = computed(() => /\.txt$/i.test(props.modelValue.sourcePath.trim()));
</script>

<template>
  <Dialog
    :open="open"
    :title="t('translation.create.title')"
    :description="t('translation.create.description')"
    size="lg"
    height="fixed"
    @update:open="emit('update:open', $event)"
  >
    <form class="create-project" @submit.prevent="emit('create')">
      <Banner v-if="error" variant="danger">{{ error }}</Banner>

      <Field :label="t('translation.create.titleLabel')" :hint="t('translation.create.titleHint')">
        <Input
          :model-value="modelValue.title"
          :placeholder="t('translation.create.titlePlaceholder')"
          @update:model-value="updateField('title', String($event))"
        />
      </Field>

      <Field :label="t('translation.create.sourceLabel')" :hint="t('translation.create.sourceHint')">
        <input
          ref="sourceInput"
          class="create-project__file-input"
          type="file"
          accept=".epub,application/epub+zip,.txt,text/plain"
          @change="onSourceFile"
        />
        <div class="create-project__picker">
          <div class="create-project__picked-path" :class="{ 'is-empty': !modelValue.sourcePath }">
            <Icon name="file-text" size="md" />
            <span>{{ modelValue.sourcePath || t('translation.create.sourcePlaceholder') }}</span>
          </div>
          <Button variant="secondary" type="button" @click="pickSource">
            <Icon name="file-plus" size="md" />
            {{ t('translation.create.chooseSource') }}
          </Button>
        </div>
        <details class="create-project__advanced">
          <summary>{{ t('translation.create.advancedSource') }}</summary>
          <Input
            :model-value="modelValue.sourcePath"
            :placeholder="t('translation.create.advancedSourcePlaceholder')"
            @update:model-value="updateField('sourcePath', String($event)); emit('source-path', String($event))"
          />
        </details>
        <Field
          v-if="isTxtSource"
          class="create-project__chapter-pattern"
          :label="t('translation.create.chapterPatternLabel')"
          :hint="t('translation.create.chapterPatternHint')"
        >
          <Input
            :model-value="modelValue.chapterPattern"
            :placeholder="t('translation.create.chapterPatternPlaceholder')"
            @update:model-value="updateField('chapterPattern', String($event))"
          />
        </Field>
      </Field>

      <div class="create-project__language-grid">
        <Field
          :label="t('translation.create.sourceLanguageLabel')"
          :hint="t('translation.create.sourceLanguageHint')"
        >
          <Input
            :model-value="modelValue.sourceLanguage"
            list="translation-source-languages"
            :placeholder="t('translation.create.sourceLanguagePlaceholder')"
            @update:model-value="updateField('sourceLanguage', String($event))"
          />
          <datalist id="translation-source-languages">
            <option value="auto">{{ t('translation.create.languageAuto') }}</option>
            <option value="en">{{ t('translation.create.languageEnglish') }}</option>
            <option value="zh-CN">{{ t('translation.create.languageChinese') }}</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="es">Español</option>
          </datalist>
        </Field>
        <Field
          :label="t('translation.create.targetLanguageLabel')"
          :hint="t('translation.create.targetLanguageHint')"
        >
          <Select
            :model-value="modelValue.targetLanguage"
            @update:model-value="updateTargetLanguage"
          >
            <option value="zh-CN">{{ t('translation.create.languageChinese') }}</option>
            <option value="en">{{ t('translation.create.languageEnglish') }}</option>
          </Select>
        </Field>
      </div>

      <Field :label="t('translation.create.workspaceLabel')" :hint="t('translation.create.workspaceHint')">
        <div class="create-project__picker">
          <Input
            :model-value="modelValue.workspacePath"
            :placeholder="t('translation.create.workspacePlaceholder')"
            readonly
          />
          <Button variant="secondary" type="button" @click="emit('choose-workspace')">
            <Icon name="folder-plus" size="md" />
            {{ t('translation.create.chooseWorkspace') }}
          </Button>
        </div>
      </Field>

      <details class="create-project__advanced-settings">
        <summary>{{ t('translation.create.advancedSettings') }}</summary>
        <div class="create-project__advanced-settings-body">
      <div class="create-project__row">
        <Field
          class="create-project__agents"
          :label="t('translation.create.agentCountLabel')"
          :hint="t('translation.create.agentCountHint')"
        >
          <Input
            :model-value="modelValue.agentCount"
            type="number"
            min="2"
            max="128"
            step="1"
            @update:model-value="updateAgentCount(String($event))"
          />
        </Field>
      </div>

      <div class="create-project__policy-grid">
        <Field
          :label="t('translation.settings.executionPolicy.softBudget')"
          :hint="t('translation.settings.executionPolicy.softBudgetHint')"
        >
          <Input
            :model-value="budgetUsd(modelValue.executionPolicy.softBudgetMicros)"
            type="number"
            min="0"
            step="1"
            @update:model-value="updateBudget('softBudgetMicros', String($event))"
          />
        </Field>
        <Field
          :label="t('translation.settings.executionPolicy.hardBudget')"
          :hint="t('translation.settings.executionPolicy.hardBudgetHint')"
        >
          <Input
            :model-value="budgetUsd(modelValue.executionPolicy.hardBudgetMicros)"
            type="number"
            :min="budgetUsd(modelValue.executionPolicy.softBudgetMicros)"
            step="1"
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
            @update:model-value="updatePolicyInteger('maxRetries', String($event))"
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
            :max="modelValue.agentCount"
            step="1"
            @update:model-value="updatePolicyInteger('maxConcurrency', String($event))"
          />
        </Field>
      </div>

      <fieldset class="create-project__workflow">
        <legend>{{ t('translation.create.workflowTitle') }}</legend>
        <p>{{ t('translation.create.workflowHint') }}</p>

        <div v-if="secondReviewForced" class="create-project__quality-notice">
          <Banner variant="warning">{{ qualityNotice }}</Banner>
          <Button variant="secondary" size="sm" type="button" @click="emit('setup-bge')">
            <Icon name="download" size="md" />
            {{ setupBgeLabel }}
          </Button>
        </div>

        <div class="create-project__workflow-grid">
          <div class="create-project__workflow-item is-required">
            <Checkbox :model-value="true" disabled>
              {{ t('translation.create.firstTranslation') }}
            </Checkbox>
            <span>{{ t('translation.create.firstTranslationHint') }}</span>
          </div>
          <div class="create-project__workflow-item is-required">
            <Checkbox :model-value="true" disabled>
              {{ t('translation.create.firstReview') }}
            </Checkbox>
            <span>{{ t('translation.create.firstReviewHint') }}</span>
          </div>
          <div class="create-project__workflow-item">
            <Checkbox
              :model-value="modelValue.workflow.secondTranslation"
              @update:model-value="updateWorkflow('secondTranslation', $event)"
            >
              {{ t('translation.create.secondTranslation') }}
            </Checkbox>
            <span>{{ t('translation.create.secondTranslationHint') }}</span>
          </div>
          <div class="create-project__workflow-item">
            <Checkbox
              :model-value="effectiveSecondReview"
              :disabled="secondReviewForced"
              @update:model-value="updateWorkflow('secondReview', $event)"
            >
              {{ t('translation.create.secondReview') }}
            </Checkbox>
            <span>{{ t('translation.create.secondReviewHint') }}</span>
          </div>
          <div class="create-project__workflow-item">
            <Checkbox
              :model-value="modelValue.workflow.consistencyReview"
              @update:model-value="updateWorkflow('consistencyReview', $event)"
            >
              {{ t('translation.create.consistencyReview') }}
            </Checkbox>
            <span>{{ t('translation.create.consistencyReviewHint') }}</span>
          </div>
        </div>
      </fieldset>
        </div>
      </details>
    </form>

    <template #foot>
      <Button variant="secondary" :disabled="saving" @click="emit('update:open', false)">
        {{ t('translation.create.cancel') }}
      </Button>
      <Button :loading="saving" :disabled="!canCreate" @click="emit('create')">
        {{ t('translation.create.submit') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.create-project {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.create-project__file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.create-project__picker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.create-project__picked-path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: 38px;
  flex: 1;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-size: var(--text-base);
}

.create-project__picked-path.is-empty {
  color: var(--color-text-faint);
}

.create-project__picked-path span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.create-project__advanced {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.create-project__advanced summary {
  width: fit-content;
  cursor: pointer;
}

.create-project__advanced summary:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}

.create-project__advanced[open] summary {
  margin-bottom: var(--space-2);
}

.create-project__advanced-settings {
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.create-project__advanced-settings summary {
  width: fit-content;
  cursor: pointer;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.create-project__advanced-settings summary:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}

.create-project__advanced-settings-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-3);
}

.create-project__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.create-project__grow {
  min-width: 0;
  flex: 1;
}

.create-project__chapter-pattern {
  margin-top: var(--space-2);
}

.create-project__agents {
  width: calc(var(--space-8) * 4);
  flex: none;
}

.create-project__policy-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.create-project__language-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.create-project__workflow {
  margin: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.create-project__workflow legend {
  padding: 0 var(--space-1);
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.create-project__workflow > p {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.create-project__quality-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.create-project__quality-notice > :first-child {
  min-width: 0;
  flex: 1;
}

.create-project__quality-notice > :deep(button) {
  flex: none;
}

.create-project__workflow-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.create-project__workflow-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.create-project__workflow-item.is-required {
  background: var(--color-surface-sunken);
}

.create-project__workflow-item > span {
  padding-left: calc(17px + var(--space-2));
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

@media (max-width: 640px) {
  .create-project__picker,
  .create-project__row,
  .create-project__quality-notice {
    align-items: stretch;
    flex-direction: column;
  }

  .create-project__agents {
    width: 100%;
  }

  .create-project__workflow-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .create-project__policy-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .create-project__language-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
