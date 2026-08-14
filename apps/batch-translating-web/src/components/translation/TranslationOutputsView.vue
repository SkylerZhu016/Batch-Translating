<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import type { TranslationOutput } from './types';

withDefaults(defineProps<{
  outputs: TranslationOutput[];
  loading?: boolean;
}>(), {
  loading: false,
});

const emit = defineEmits<{
  open: [output: TranslationOutput];
  reveal: [output: TranslationOutput];
}>();

const { t } = useI18n();
</script>

<template>
  <section class="outputs-view">
    <header class="outputs-view__header">
      <div>
        <h1>{{ t('translation.outputs.title') }}</h1>
        <p>{{ t('translation.outputs.subtitle') }}</p>
      </div>
      <Badge v-if="outputs.length" variant="success" dot>{{ outputs.length }}</Badge>
    </header>

    <div v-if="loading" class="outputs-view__loading" role="status">
      <Spinner :label="t('translation.outputs.loading')" />
      <span>{{ t('translation.outputs.loading') }}</span>
    </div>

    <EmptyState
      v-else-if="outputs.length === 0"
      :title="t('translation.outputs.emptyTitle')"
      :hint="t('translation.outputs.emptyHint')"
    >
      <template #icon><Icon name="download" size="lg" /></template>
    </EmptyState>

    <div v-else class="outputs-view__grid">
      <Card v-for="output in outputs" :key="output.id" class="output-card">
        <template #head>
          <Icon name="file-text" size="md" />
          <strong>{{ output.projectTitle }}</strong>
          <Badge variant="success" size="sm" dot>{{ t('translation.outputs.ready') }}</Badge>
        </template>
        <dl class="output-card__facts">
          <div>
            <dt>{{ t('translation.outputs.source') }}</dt>
            <dd>{{ output.sourcePath }}</dd>
          </div>
          <div>
            <dt>{{ t('translation.outputs.output') }}</dt>
            <dd>{{ output.outputPath }}</dd>
          </div>
          <div>
            <dt>{{ t('translation.outputs.exportedAt') }}</dt>
            <dd>{{ output.exportedAt }}</dd>
          </div>
        </dl>
        <template #foot>
          <Button variant="secondary" size="sm" @click="emit('reveal', output)">
            <Icon name="folder" size="sm" />
            {{ t('translation.outputs.reveal') }}
          </Button>
          <Button size="sm" @click="emit('open', output)">
            <Icon name="external-link" size="sm" />
            {{ t('translation.outputs.open') }}
          </Button>
        </template>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.outputs-view {
  height: 100%;
  padding: var(--space-6);
  overflow-y: auto;
}

.outputs-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--p-content-wide);
  margin: 0 auto var(--space-6);
}

.outputs-view__header h1 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.outputs-view__header p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}

.outputs-view__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 50%;
  color: var(--color-text-muted);
}

.outputs-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: var(--space-4);
  width: 100%;
  max-width: var(--p-content-wide);
  margin: 0 auto;
}

.output-card {
  min-width: 0;
  background: var(--color-surface-raised);
}

.output-card :deep(.ui-card__head) strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output-card__facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
}

.output-card__facts dt {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}

.output-card__facts dd {
  overflow-wrap: anywhere;
  margin: var(--space-1) 0 0;
  color: var(--color-text);
  font-size: var(--text-sm);
}

@media (max-width: 640px) {
  .outputs-view {
    padding: var(--space-4);
  }
}
</style>
