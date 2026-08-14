<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import type { TranslationIssue, TranslationIssueSeverity } from './types';

withDefaults(defineProps<{
  issues: TranslationIssue[];
  loading?: boolean;
}>(), {
  loading: false,
});

const emit = defineEmits<{
  'open-project': [projectId: string];
}>();

const { t } = useI18n();

function badgeVariant(severity: TranslationIssueSeverity): 'info' | 'warning' | 'danger' {
  if (severity === 'error') return 'danger';
  return severity;
}
</script>

<template>
  <section class="issues-view">
    <header class="issues-view__header">
      <div>
        <h1>{{ t('translation.issues.title') }}</h1>
        <p>{{ t('translation.issues.subtitle') }}</p>
      </div>
      <Badge v-if="issues.length" variant="warning" dot>{{ issues.length }}</Badge>
    </header>

    <div v-if="loading" class="issues-view__loading" role="status">
      <Spinner :label="t('translation.issues.loading')" />
      <span>{{ t('translation.issues.loading') }}</span>
    </div>

    <EmptyState
      v-else-if="issues.length === 0"
      :title="t('translation.issues.emptyTitle')"
      :hint="t('translation.issues.emptyHint')"
    >
      <template #icon><Icon name="check-list" size="lg" /></template>
    </EmptyState>

    <div v-else class="issues-view__list">
      <article v-for="issue in issues" :key="issue.id" class="issue-card">
        <header class="issue-card__head">
          <Badge :variant="badgeVariant(issue.severity)" dot>
            {{ t(`translation.issues.severityLevels.${issue.severity}`) }}
          </Badge>
          <strong>{{ issue.projectTitle }}</strong>
          <time>{{ issue.createdAt }}</time>
        </header>
        <p>{{ issue.message }}</p>
        <footer class="issue-card__foot">
          <dl>
            <div v-if="issue.chapterName">
              <dt>{{ t('translation.issues.chapter') }}</dt>
              <dd>{{ issue.chapterName }}</dd>
            </div>
            <div v-if="issue.stageId">
              <dt>{{ t('translation.issues.stage') }}</dt>
              <dd>{{ t(`translation.stages.${issue.stageId}`) }}</dd>
            </div>
          </dl>
          <Button variant="secondary" size="sm" @click="emit('open-project', issue.projectId)">
            {{ t('translation.issues.openProject') }}
          </Button>
        </footer>
      </article>
    </div>
  </section>
</template>

<style scoped>
.issues-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-5);
  height: 100%;
  min-height: 0;
  padding: var(--space-6);
  overflow: hidden;
}

.issues-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--p-content-wide);
  margin: 0 auto;
}

.issues-view__header h1 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.issues-view__header p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}

.issues-view__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
}

.issues-view__list {
  display: flex;
  width: 100%;
  max-width: var(--p-content-wide);
  min-height: 0;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0 auto;
  overflow-y: auto;
}

.issue-card {
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.issue-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
}

.issue-card__head strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-card__head time {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.issue-card > p {
  margin: 0;
  padding: var(--space-4);
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
}

.issue-card__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-top: 1px solid var(--color-line);
}

.issue-card__foot dl {
  display: flex;
  min-width: 0;
  gap: var(--space-5);
  margin: 0;
}

.issue-card__foot dt {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}

.issue-card__foot dd {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

@media (max-width: 640px) {
  .issues-view {
    padding: var(--space-4);
  }

  .issue-card__head,
  .issue-card__foot {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
