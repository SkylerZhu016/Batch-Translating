<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import StatusDot from '../ui/StatusDot.vue';
import type { TranslationStage, TranslationStageStatus } from './types';

defineProps<{ stages: TranslationStage[] }>();

const { t } = useI18n();

function dotStatus(status: TranslationStageStatus): string {
  if (status === 'completed') return 'completed';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return 'idle';
}

function badgeVariant(status: TranslationStageStatus): 'neutral' | 'info' | 'success' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'running') return 'info';
  if (status === 'failed') return 'danger';
  return 'neutral';
}
</script>

<template>
  <section class="stage-rail" :aria-label="t('translation.run.stageTitle')">
    <div class="stage-rail__head">
      <h2>{{ t('translation.run.stageTitle') }}</h2>
    </div>
    <ol class="stage-rail__list">
      <li
        v-for="(stage, index) in stages"
        :key="stage.id"
        class="stage-rail__item"
        :class="`is-${stage.status}`"
      >
        <span class="stage-rail__index">{{ index + 1 }}</span>
        <span class="stage-rail__copy">
          <strong>{{ t(`translation.stages.${stage.id}`) }}</strong>
          <small v-if="stage.detail">{{ stage.detail }}</small>
        </span>
        <Badge :variant="badgeVariant(stage.status)" size="sm">
          <StatusDot :status="dotStatus(stage.status)" />
          {{ t(`translation.stageStatus.${stage.status}`) }}
        </Badge>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.stage-rail {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.stage-rail__head {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}

.stage-rail__head h2 {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.stage-rail__list {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2);
  overflow-x: auto;
  list-style: none;
}

.stage-rail__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: calc(var(--space-8) * 7);
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.stage-rail__item.is-running {
  border-color: var(--color-accent-bd);
}

.stage-rail__item.is-failed {
  border-color: var(--color-danger-bd);
}

.stage-rail__index {
  display: inline-grid;
  place-items: center;
  width: var(--space-6);
  height: var(--space-6);
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.stage-rail__copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
}

.stage-rail__copy strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-rail__copy small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
