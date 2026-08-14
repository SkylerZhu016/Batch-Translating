<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import StatusDot from '../ui/StatusDot.vue';
import type { TranslationAgent, TranslationAgentStatus } from './types';

const props = defineProps<{ agents: TranslationAgent[] }>();

const { t } = useI18n();
const page = ref(1);
const pageSize = 16;
const pageCount = computed(() => Math.max(1, Math.ceil(props.agents.length / pageSize)));
const visibleAgents = computed(() => {
  const start = (page.value - 1) * pageSize;
  return props.agents.slice(start, start + pageSize);
});

watch(() => props.agents.length, () => {
  page.value = Math.min(page.value, pageCount.value);
});

function progress(agent: TranslationAgent): number {
  return Math.min(100, Math.max(0, agent.progress ?? 0));
}

function badgeVariant(status: TranslationAgentStatus): 'neutral' | 'info' | 'success' | 'danger' {
  if (status === 'working') return 'info';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}
</script>

<template>
<section class="swarm-panel">
  <header class="swarm-panel__head">
    <div>
      <h2>{{ t('translation.run.swarmTitle') }}</h2>
      <p>{{ t('translation.run.swarmSummary', { count: agents.length }) }}</p>
    </div>
    <Badge variant="info" size="sm" dot>{{ agents.length }}</Badge>
  </header>

  <div class="swarm-panel__body">
    <EmptyState
      v-if="agents.length === 0"
      :title="t('translation.run.noAgentsTitle')"
      :hint="t('translation.run.noAgentsHint')"
    >
      <template #icon><Icon name="git-fork" size="lg" /></template>
    </EmptyState>

    <div v-else class="swarm-panel__grid">
      <article v-for="agent in visibleAgents" :key="agent.id" class="agent-card">
        <header class="agent-card__head">
          <StatusDot :status="agent.status" />
          <strong>{{ agent.name }}</strong>
          <Badge :variant="badgeVariant(agent.status)" size="sm">
            {{ t(`translation.run.agent${agent.status[0]?.toUpperCase()}${agent.status.slice(1)}`) }}
          </Badge>
        </header>
        <div class="agent-card__body">
          <span class="agent-card__task">
            {{ agent.chapterName || t('translation.run.agentWaiting') }}
          </span>
          <small v-if="agent.stageId">{{ t(`translation.stages.${agent.stageId}`) }}</small>
          <div
            class="agent-card__progress"
            role="progressbar"
            :aria-valuenow="progress(agent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${progress(agent)}%` }" />
          </div>
        </div>
      </article>
    </div>
  </div>

  <footer class="swarm-panel__pager">
    <Button
      variant="ghost"
      size="sm"
      :disabled="page <= 1"
      @click="page -= 1"
    >
      <Icon name="chevron-up" size="sm" />
      {{ t('translation.run.pagePrevious') }}
    </Button>
    <span>{{ t('translation.run.pageLabel', { page, pages: pageCount }) }}</span>
    <Button
      variant="ghost"
      size="sm"
      :disabled="page >= pageCount"
      @click="page += 1"
    >
      {{ t('translation.run.pageNext') }}
      <Icon name="chevron-down" size="sm" />
    </Button>
  </footer>
</section>
</template>

<style scoped>
.swarm-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.swarm-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}

.swarm-panel__head h2 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.swarm-panel__head p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.swarm-panel__body {
  min-height: 0;
  padding: var(--space-2);
  overflow-x: auto;
  overflow-y: auto;
}

.swarm-panel__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-template-rows: repeat(4, minmax(calc(var(--space-8) * 2), 1fr));
  gap: var(--space-2);
  min-width: calc(var(--space-8) * 20);
  min-height: 100%;
}

.agent-card {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.agent-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-line);
}

.agent-card__head strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card__body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}

.agent-card__task {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card__body small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card__progress {
  height: var(--space-1);
  margin-top: auto;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
}

.agent-card__progress span {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.swarm-panel__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--color-line);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
