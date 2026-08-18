<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import Banner from '../ui/Banner.vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import Checkbox from '../ui/Checkbox.vue';
import Icon from '../ui/Icon.vue';
import Select from '../ui/Select.vue';
import Spinner from '../ui/Spinner.vue';
import type {
  BgeModelDownloadSource,
  BgeModelSetupErrorCode,
  BgeModelSetupStatus,
} from './bgeModelSetup.types';

const props = withDefaults(defineProps<{
  status: BgeModelSetupStatus;
  source?: BgeModelDownloadSource;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  diskAvailableBytes?: number;
  diskRequiredBytes?: number;
  fingerprint?: string;
  modelPath?: string;
  error?: string;
  errorCode?: BgeModelSetupErrorCode;
  cpuFallbackEnabled?: boolean;
  disabled?: boolean;
  canRebuild?: boolean;
}>(), {
  source: 'mirror',
  cpuFallbackEnabled: true,
  disabled: false,
  canRebuild: true,
});

const emit = defineEmits<{
  'update:source': [value: BgeModelDownloadSource];
  'update:cpuFallbackEnabled': [value: boolean];
  detect: [];
  download: [];
  cancel: [];
  retry: [];
  verify: [];
  rebuild: [];
}>();

const { t } = useI18n();
const titleId = useId();
const sourceId = useId();
const isBusy = computed(() => props.status === 'downloading' || props.status === 'verifying');
const normalizedProgress = computed(() => {
  if (props.progress === undefined || !Number.isFinite(props.progress)) return undefined;
  return Math.min(100, Math.max(0, props.progress));
});
const progressLabel = computed(() => (
  t(props.status === 'verifying'
    ? 'translation.settings.bge.verifyingProgress'
    : 'translation.settings.bge.progress')
));
const progressText = computed(() => {
  if (props.downloadedBytes !== undefined && props.totalBytes !== undefined) {
    return t('translation.settings.bge.downloaded', {
      done: formatBytes(props.downloadedBytes),
      total: formatBytes(props.totalBytes),
    });
  }
  if (normalizedProgress.value !== undefined) {
    return t('translation.settings.bge.percent', { value: Math.round(normalizedProgress.value) });
  }
  return '';
});
const diskText = computed(() => {
  const parts: string[] = [];
  if (props.diskAvailableBytes !== undefined) {
    parts.push(t('translation.settings.bge.diskAvailable', { value: formatBytes(props.diskAvailableBytes) }));
  }
  const required = props.diskRequiredBytes ?? props.totalBytes;
  if (required !== undefined) {
    parts.push(t('translation.settings.bge.diskRequired', { value: formatBytes(required) }));
  }
  return parts.length > 0 ? parts.join(' · ') : t('translation.settings.bge.diskUnknown');
});
const displayError = computed(() => {
  if (props.error?.trim()) return props.error;
  if (!props.errorCode) return '';
  return t(`translation.errors.bge.${props.errorCode}`);
});
const statusTone = computed(() => {
  if (props.status === 'failed') return 'danger';
  if (props.status === 'available') return 'success';
  if (props.status === 'missing') return 'warning';
  return 'info';
});

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function updateSource(value: string): void {
  if (value === 'mirror' || value === 'official') emit('update:source', value);
}
</script>

<template>
  <section class="bge-setup" :aria-labelledby="titleId">
    <Card>
      <template #head>
        <Icon name="sparkles" size="md" />
        <span :id="titleId">{{ t('translation.settings.bge.title') }}</span>
        <span
          class="bge-setup__status"
          :class="`is-${statusTone}`"
          role="status"
          aria-live="polite"
        >
          <Spinner
            v-if="isBusy"
            size="sm"
            :label="t(`translation.settings.bge.statuses.${status}`)"
          />
          <Icon
            v-else-if="status === 'available' || status === 'detected'"
            name="check"
            size="sm"
          />
          <Icon v-else-if="status === 'failed'" name="alert-triangle" size="sm" />
          <span>{{ t(`translation.settings.bge.statuses.${status}`) }}</span>
        </span>
      </template>

      <div class="bge-setup__content">
        <p class="bge-setup__subtitle">{{ t('translation.settings.bge.subtitle') }}</p>
        <p class="bge-setup__status-description">
          {{ t(`translation.settings.bge.statusDescriptions.${status}`) }}
        </p>

        <Banner variant="warning">
          {{ t('translation.settings.bge.qualityWarning') }}
        </Banner>

        <div class="bge-setup__requirements">
          <div class="bge-setup__requirement">
            <Icon name="bolt" size="md" />
            <div>
              <strong>{{ t('translation.settings.bge.hardwareTitle') }}</strong>
              <span>{{ t('translation.settings.bge.hardware') }}</span>
            </div>
          </div>
          <div class="bge-setup__requirement">
            <Icon name="folder" size="md" />
            <div>
              <strong>{{ t('translation.settings.bge.diskTitle') }}</strong>
              <span>{{ diskText }}</span>
            </div>
          </div>
        </div>

        <div class="bge-setup__controls">
          <div class="bge-setup__source">
            <label :for="sourceId">{{ t('translation.settings.bge.sourceLabel') }}</label>
            <Select
              :id="sourceId"
              :model-value="source"
              :disabled="disabled || isBusy"
              @update:model-value="updateSource"
            >
              <option value="mirror">{{ t('translation.settings.bge.mirror') }}</option>
              <option value="official">{{ t('translation.settings.bge.official') }}</option>
            </Select>
            <span>{{ t('translation.settings.bge.sourceHint') }}</span>
          </div>

          <div class="bge-setup__cpu">
            <Checkbox
              :model-value="cpuFallbackEnabled"
              :disabled="disabled"
              @update:model-value="emit('update:cpuFallbackEnabled', $event)"
            >
              {{ t('translation.settings.bge.cpuFallback') }}
            </Checkbox>
            <span>{{ t('translation.settings.bge.cpuFallbackHint') }}</span>
          </div>
        </div>

        <div v-if="isBusy" class="bge-setup__progress" aria-live="polite">
          <div class="bge-setup__progress-copy">
            <span>{{ progressLabel }}</span>
            <span v-if="progressText">{{ progressText }}</span>
          </div>
          <progress
            v-if="normalizedProgress !== undefined"
            :value="normalizedProgress"
            max="100"
            :aria-label="progressLabel"
          />
          <progress v-else max="100" :aria-label="progressLabel" />
        </div>

        <Banner v-if="displayError" variant="danger">
          {{ displayError }}
        </Banner>

        <dl class="bge-setup__metadata">
          <div>
            <dt>{{ t('translation.settings.bge.fingerprint') }}</dt>
            <dd :class="{ 'is-pending': !fingerprint }">
              {{ fingerprint || t('translation.settings.bge.fingerprintPending') }}
            </dd>
          </div>
          <div v-if="modelPath">
            <dt>{{ t('translation.settings.bge.modelPath') }}</dt>
            <dd>{{ modelPath }}</dd>
          </div>
        </dl>

        <div class="bge-setup__actions">
          <Button
            v-if="status === 'missing' || status === 'failed' || status === 'available'"
            variant="secondary"
            :disabled="disabled"
            @click="emit('detect')"
          >
            <Icon name="refresh" size="md" />
            {{ t('translation.settings.bge.redetect') }}
          </Button>
          <Button
            v-if="status === 'missing'"
            :disabled="disabled"
            @click="emit('download')"
          >
            <Icon name="download" size="md" />
            {{ t('translation.settings.bge.download') }}
          </Button>
          <Button
            v-else-if="status === 'detected'"
            :disabled="disabled"
            @click="emit('verify')"
          >
            <Icon name="check-list" size="md" />
            {{ t('translation.settings.bge.verify') }}
          </Button>
          <Button
            v-else-if="isBusy"
            variant="secondary"
            :disabled="disabled"
            @click="emit('cancel')"
          >
            <Icon name="stop" size="md" />
            {{ t('translation.settings.bge.cancel') }}
          </Button>
          <Button
            v-else-if="status === 'failed'"
            :disabled="disabled"
            @click="emit('retry')"
          >
            <Icon name="refresh" size="md" />
            {{ t('translation.settings.bge.retry') }}
          </Button>
          <Button
            v-if="status === 'available' && canRebuild"
            :disabled="disabled"
            @click="emit('rebuild')"
          >
            <Icon name="refresh" size="md" />
            {{ t('translation.settings.bge.rebuild') }}
          </Button>
        </div>
      </div>
    </Card>
  </section>
</template>

<style scoped>
.bge-setup {
  width: 100%;
  min-width: 0;
  color: var(--color-text);
}

.bge-setup__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  padding: 2px var(--space-2);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}

.bge-setup__status.is-success {
  border-color: var(--color-success-bd);
  background: var(--color-success-soft);
  color: var(--color-success);
}

.bge-setup__status.is-warning {
  border-color: var(--color-warning-bd);
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.bge-setup__status.is-danger {
  border-color: var(--color-danger-bd);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.bge-setup__content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-4);
}

.bge-setup__subtitle,
.bge-setup__status-description {
  margin: 0;
  line-height: var(--leading-normal);
}

.bge-setup__subtitle {
  color: var(--color-text);
  font-size: var(--text-base);
}

.bge-setup__status-description {
  margin-top: calc(-1 * var(--space-2));
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.bge-setup__requirements {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.bge-setup__requirement {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
}

.bge-setup__requirement > :deep(svg) {
  flex: none;
  margin-top: 2px;
}

.bge-setup__requirement div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.bge-setup__requirement strong {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.bge-setup__requirement span {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.bge-setup__controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
}

.bge-setup__source,
.bge-setup__cpu {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.bge-setup__source > label {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.bge-setup__source > span,
.bge-setup__cpu > span {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.bge-setup__cpu {
  justify-content: center;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.bge-setup__cpu > span {
  padding-left: calc(17px + var(--space-2));
}

.bge-setup__progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.bge-setup__progress-copy {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.bge-setup__progress progress {
  appearance: none;
  width: 100%;
  height: 8px;
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.bge-setup__progress progress::-webkit-progress-bar {
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.bge-setup__progress progress::-webkit-progress-value {
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.bge-setup__progress progress::-moz-progress-bar {
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.bge-setup__metadata {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}

.bge-setup__metadata > div {
  display: grid;
  grid-template-columns: minmax(96px, 0.25fr) minmax(0, 1fr);
  gap: var(--space-3);
}

.bge-setup__metadata dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.bge-setup__metadata dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.bge-setup__metadata dd.is-pending {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
}

.bge-setup__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

@media (max-width: 640px) {
  .bge-setup__requirements,
  .bge-setup__controls {
    grid-template-columns: minmax(0, 1fr);
  }

  .bge-setup__metadata > div {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-1);
  }

  .bge-setup__actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .bge-setup__actions > :deep(*) {
    width: 100%;
  }
}
</style>
