<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import StatusDot from '../ui/StatusDot.vue';
import type { TranslationChapter, TranslationChapterStatus } from './types';

const props = defineProps<{ chapters: TranslationChapter[] }>();
const { t } = useI18n();

const completed = computed(() => props.chapters.filter((chapter) => chapter.status === 'completed').length);

function dotStatus(status: TranslationChapterStatus): string {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'translating' || status === 'reviewing') return 'running';
  return 'idle';
}

function badgeVariant(status: TranslationChapterStatus): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'reviewing') return 'warning';
  if (status === 'translating') return 'info';
  return 'neutral';
}

function progress(chapter: TranslationChapter): number {
  return Math.min(100, Math.max(0, chapter.progress));
}
</script>

<template>
  <section class="chapter-panel">
    <header class="chapter-panel__head">
      <div>
        <h2>{{ t('translation.run.chapterTitle') }}</h2>
        <p>{{ t('translation.run.chapterSummary', { completed, total: chapters.length }) }}</p>
      </div>
      <Badge size="sm">{{ completed }}/{{ chapters.length }}</Badge>
    </header>

    <div class="chapter-panel__list">
      <EmptyState
        v-if="chapters.length === 0"
        :title="t('translation.run.noChaptersTitle')"
        :hint="t('translation.run.noChaptersHint')"
      >
        <template #icon><Icon name="list" size="lg" /></template>
      </EmptyState>

      <template v-else>
        <article v-for="chapter in chapters" :key="chapter.id" class="chapter-row">
          <StatusDot :status="dotStatus(chapter.status)" />
          <div class="chapter-row__main">
            <div class="chapter-row__title">
              <strong>{{ chapter.title }}</strong>
              <Badge :variant="badgeVariant(chapter.status)" size="sm">
                {{ t(`translation.run.chapter${chapter.status[0]?.toUpperCase()}${chapter.status.slice(1)}`) }}
              </Badge>
            </div>
            <div
              class="chapter-row__progress"
              role="progressbar"
              :aria-valuenow="progress(chapter)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${progress(chapter)}%` }" />
            </div>
            <div class="chapter-row__meta">
              <span v-if="chapter.agentName">{{ chapter.agentName }}</span>
              <Badge v-if="chapter.issueCount" variant="warning" size="sm">
                {{ t('translation.run.chapterIssues', { count: chapter.issueCount }) }}
              </Badge>
              <span>{{ progress(chapter) }}%</span>
            </div>
          </div>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.chapter-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.chapter-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}

.chapter-panel__head h2 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.chapter-panel__head p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.chapter-panel__list {
  min-height: 0;
  overflow-y: auto;
}

.chapter-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface-raised);
}

.chapter-row:last-child {
  border-bottom: 0;
}

.chapter-row > :first-child {
  margin-top: var(--space-2);
}

.chapter-row__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
}

.chapter-row__title,
.chapter-row__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.chapter-row__title strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-row__progress {
  height: var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.chapter-row__progress span {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.chapter-row__meta {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.chapter-row__meta > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
