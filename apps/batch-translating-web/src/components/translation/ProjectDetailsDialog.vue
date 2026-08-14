<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import type { TranslationProject } from './types';

defineProps<{
  open: boolean;
  project?: TranslationProject;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  continue: [project: TranslationProject];
  'open-output': [project: TranslationProject];
  delete: [project: TranslationProject];
}>();

const { t } = useI18n();
</script>

<template>
  <Dialog
    :open="open"
    :title="project?.title || t('translation.details.title')"
    size="lg"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="project" class="project-details">
      <dl class="project-details__facts">
        <div>
          <dt>{{ t('translation.details.source') }}</dt>
          <dd>{{ project.sourcePath }}</dd>
        </div>
        <div>
          <dt>{{ t('translation.details.workspace') }}</dt>
          <dd>{{ project.workspacePath }}</dd>
        </div>
        <div>
        </div>
        <div>
          <dt>{{ t('translation.details.agents') }}</dt>
          <dd>{{ project.agentCount }}</dd>
        </div>
        <div v-if="project.outputPath">
          <dt>{{ t('translation.details.output') }}</dt>
          <dd>{{ project.outputPath }}</dd>
        </div>
      </dl>

      <section class="project-details__workflow">
        <h3>{{ t('translation.details.workflow') }}</h3>
        <div class="project-details__badges">
          <Badge variant="success" dot>{{ t('translation.create.firstTranslation') }}</Badge>
          <Badge variant="success" dot>{{ t('translation.create.firstReview') }}</Badge>
          <Badge v-if="project.workflow.secondTranslation" variant="info" dot>
            {{ t('translation.create.secondTranslation') }}
          </Badge>
          <Badge v-if="project.workflow.secondReview" variant="info" dot>
            {{ t('translation.create.secondReview') }}
          </Badge>
          <Badge v-if="project.workflow.consistencyReview" variant="info" dot>
            {{ t('translation.create.consistencyReview') }}
          </Badge>
        </div>
      </section>
    </div>

    <template #foot>
      <Button
        v-if="project"
        variant="danger-soft"
        @click="emit('delete', project)"
      >
        {{ t('translation.projects.delete') }}
      </Button>
      <Button variant="secondary" @click="emit('update:open', false)">
        {{ t('translation.details.close') }}
      </Button>
      <Button
        v-if="project?.status === 'completed'"
        @click="emit('open-output', project)"
      >
        {{ t('translation.projects.openOutput') }}
      </Button>
      <Button
        v-else-if="project"
        @click="emit('continue', project)"
      >
        {{ t('translation.projects.continue') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.project-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.project-details__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.project-details__facts div {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.project-details__facts div:nth-child(-n + 2),
.project-details__facts div:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.project-details__facts dt {
  margin-bottom: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.project-details__facts dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.project-details__workflow h3 {
  margin: 0 0 var(--space-2);
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.project-details__badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

@media (max-width: 640px) {
  .project-details__facts {
    grid-template-columns: minmax(0, 1fr);
  }

  .project-details__facts div {
    grid-column: 1;
  }
}
</style>
