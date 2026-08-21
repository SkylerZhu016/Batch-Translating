<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import AgentSwarmPanel from './AgentSwarmPanel.vue';
import ChapterProgressPanel from './ChapterProgressPanel.vue';
import type {
  TranslationAgent,
  TranslationChapter,
  TranslationProject,
  TranslationStage,
} from './types';

withDefaults(defineProps<{
  project?: TranslationProject;
  stages: TranslationStage[];
  agents: TranslationAgent[];
  chapters: TranslationChapter[];
  paused?: boolean;
}>(), {
  paused: false,
});

const emit = defineEmits<{
  'toggle-pause': [];
  'open-issue-log': [];
  'open-output': [];
}>();

const { t } = useI18n();
</script>

<template>
  <section v-if="project" class="run-workbench">
    <header class="run-workbench__header">
      <div class="run-workbench__title">
        <div>
          <h1>{{ project.title }}</h1>
          <p>{{ t('translation.run.projectSummary', {
            completed: project.completedChapters,
            total: project.totalChapters,
            agents: project.agentCount,
            round: project.revisionRound,
            target: project.targetLanguage === 'zh-CN'
              ? t('translation.create.languageChinese')
              : t('translation.create.languageEnglish'),
          }) }}</p>
        </div>
        <Badge
          :variant="project.status === 'failed' ? 'danger' : project.status === 'completed' ? 'success' : 'info'"
          dot
        >
          {{ t(`translation.projects.status.${project.status}`) }}
        </Badge>
      </div>
      <div class="run-workbench__actions">
        <Button variant="secondary" size="sm" @click="emit('open-issue-log')">
          <Icon name="alert-triangle" size="sm" />
          {{ t('translation.run.openIssues') }}
        </Button>
        <Button
          v-if="project.status === 'completed'"
          variant="secondary"
          size="sm"
          @click="emit('open-output')"
        >
          <Icon name="download" size="sm" />
          {{ t('translation.run.openOutput') }}
        </Button>
        <Button
          v-else
          :variant="project.status === 'running' ? 'secondary' : 'primary'"
          size="sm"
          @click="emit('toggle-pause')"
        >
          <Icon :name="project.status === 'running' ? 'pause' : 'play'" size="sm" />
          {{ project.status === 'running'
            ? t('translation.run.pause')
            : project.status === 'draft'
              ? t('translation.run.start')
              : t('translation.run.resume') }}
        </Button>
      </div>
    </header>

    <div class="run-workbench__panels">
      <AgentSwarmPanel :agents="agents" />
      <ChapterProgressPanel :chapters="chapters" />
    </div>
  </section>

  <EmptyState
    v-else
    class="run-workbench__empty"
    :title="t('translation.run.noProjectTitle')"
    :hint="t('translation.run.noProjectHint')"
  >
    <template #icon><Icon name="play" size="lg" /></template>
  </EmptyState>
</template>

<style scoped>
.run-workbench {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-3);
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: var(--space-4);
  overflow: hidden;
}

.run-workbench__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-width: 0;
}

.run-workbench__title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.run-workbench__title > div {
  min-width: 0;
}

.run-workbench__title h1 {
  overflow: hidden;
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-workbench__title p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.run-workbench__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.run-workbench__panels {
  display: grid;
  grid-template-columns: minmax(calc(var(--space-8) * 20), 3fr) minmax(calc(var(--space-8) * 9), 2fr);
  gap: var(--space-3);
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.run-workbench__empty {
  height: 100%;
}

@media (max-width: 640px) {
  .run-workbench {
    padding: var(--space-2);
  }

  .run-workbench__header {
    align-items: stretch;
    flex-direction: column;
  }

  .run-workbench__actions {
    overflow-x: auto;
  }
}
</style>
