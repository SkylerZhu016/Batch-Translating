<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import type { TranslationProject, TranslationProjectStatus } from './types';

withDefaults(defineProps<{
  projects: TranslationProject[];
  selectedProjectId?: string;
  loading?: boolean;
}>(), {
  loading: false,
});

const emit = defineEmits<{
  create: [];
  details: [project: TranslationProject];
  delete: [project: TranslationProject];
  continue: [project: TranslationProject];
  'open-output': [project: TranslationProject];
}>();

const { t } = useI18n();

function badgeVariant(status: TranslationProjectStatus): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'running': return 'info';
    case 'paused': return 'warning';
    case 'completed': return 'success';
    case 'failed': return 'danger';
    default: return 'neutral';
  }
}

function progress(project: TranslationProject): number {
  if (project.totalChapters <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(project.completedChapters / project.totalChapters * 100)));
}

function openDetails(project: TranslationProject): void {
  if (project.status === 'completed') {
    emit('open-output', project);
    return;
  }
  emit('details', project);
}
</script>

<template>
  <section class="projects-view">
    <header class="projects-view__header">
      <div>
        <h1>{{ t('translation.projects.title') }}</h1>
        <p>{{ t('translation.projects.subtitle') }}</p>
      </div>
      <Button @click="emit('create')">
        <Icon name="plus" size="md" />
        {{ t('translation.projects.create') }}
      </Button>
    </header>

    <div v-if="loading" class="projects-view__loading" role="status">
      <Spinner :label="t('translation.projects.loading')" />
      <span>{{ t('translation.projects.loading') }}</span>
    </div>

    <EmptyState
      v-else-if="projects.length === 0"
      :title="t('translation.projects.emptyTitle')"
      :hint="t('translation.projects.emptyHint')"
    >
      <template #icon><Icon name="folder" size="lg" /></template>
      <Button size="sm" @click="emit('create')">{{ t('translation.projects.create') }}</Button>
    </EmptyState>

    <div v-else class="projects-view__grid">
      <Card
        v-for="project in projects"
        :key="project.id"
        class="project-card"
        :class="{ 'is-selected': selectedProjectId === project.id }"
      >
        <template #head>
          <button class="project-card__title" type="button" @click="openDetails(project)">
            <Icon name="file-text" size="md" />
            <span>{{ project.title }}</span>
          </button>
          <Badge :variant="badgeVariant(project.status)" size="sm" :dot="project.status === 'running'">
            {{ t(`translation.projects.status.${project.status}`) }}
          </Badge>
        </template>

        <div class="project-card__body">
          <dl class="project-card__meta">
            <div>
            </div>
            <div>
              <dt>{{ t('translation.projects.agents') }}</dt>
              <dd>{{ project.agentCount }}</dd>
            </div>
            <div>
              <dt>{{ t('translation.projects.updated') }}</dt>
              <dd>{{ project.updatedAt }}</dd>
            </div>
          </dl>

          <div class="project-card__progress-head">
            <span>{{ t('translation.projects.progress') }}</span>
            <span>{{ progress(project) }}%</span>
          </div>
          <div
            class="project-card__progress"
            role="progressbar"
            :aria-valuenow="progress(project)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${progress(project)}%` }" />
          </div>
          <span class="project-card__chapter-count">
            {{ t('translation.projects.chapters', {
              completed: project.completedChapters,
              total: project.totalChapters,
            }) }}
          </span>
        </div>

        <template #foot>
          <Button variant="danger-soft" size="sm" @click="emit('delete', project)">
            {{ t('translation.projects.delete') }}
          </Button>
          <Button variant="secondary" size="sm" @click="openDetails(project)">
            {{ project.status === 'completed'
              ? t('translation.projects.openOutput')
              : t('translation.projects.details') }}
          </Button>
          <Button
            v-if="project.status !== 'completed'"
            size="sm"
            @click="emit('continue', project)"
          >
            <Icon name="play" size="sm" />
            {{ t('translation.projects.continue') }}
          </Button>
        </template>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.projects-view {
  height: 100%;
  padding: var(--space-6);
  overflow-y: auto;
}

.projects-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  max-width: var(--p-content-wide);
  margin: 0 auto var(--space-6);
}

.projects-view__header h1 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.projects-view__header p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}

.projects-view__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 50%;
  color: var(--color-text-muted);
}

.projects-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: var(--space-4);
  max-width: var(--p-content-wide);
  margin: 0 auto;
}

.project-card {
  min-width: 0;
  background: var(--color-surface-raised);
}

.project-card.is-selected {
  border-color: var(--color-accent);
}

.project-card :deep(.ui-card__head) {
  justify-content: space-between;
}

.project-card__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
}

.project-card__title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-card__title:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}

.project-card__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.project-card__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.project-card__meta div:last-child {
  grid-column: 1 / -1;
}

.project-card__meta dt {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}

.project-card__meta dd {
  overflow: hidden;
  margin: var(--space-1) 0 0;
  color: var(--color-text);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-card__progress-head {
  display: flex;
  justify-content: space-between;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.project-card__progress {
  height: var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.project-card__progress span {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  transition: width var(--duration-slow) var(--ease-out);
}

.project-card__chapter-count {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

@media (max-width: 640px) {
  .projects-view {
    padding: var(--space-4);
  }

  .projects-view__header {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
