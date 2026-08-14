<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import type { IconName } from '../../lib/icons';
import type { TranslationView } from './types';

withDefaults(defineProps<{
  activeView: TranslationView;
  projectCount?: number;
  issueCount?: number;
  running?: boolean;
}>(), {
  projectCount: 0,
  issueCount: 0,
  running: false,
});

const emit = defineEmits<{
  navigate: [view: TranslationView];
  'create-project': [];
  exit: [];
}>();

const { t } = useI18n();

const mainItems: { view: TranslationView; icon: IconName; count?: 'projects' | 'issues' }[] = [
  { view: 'projects', icon: 'folder', count: 'projects' },
  { view: 'run', icon: 'play' },
  { view: 'agent-console', icon: 'terminal' },
  { view: 'issues', icon: 'alert-triangle', count: 'issues' },
  { view: 'outputs', icon: 'download' },
];
</script>

<template>
  <div class="translation-shell">
    <aside class="translation-shell__sidebar">
      <header class="translation-shell__brand">
        <span class="translation-shell__brand-mark" aria-hidden="true">
          <Icon name="file-text" size="lg" />
        </span>
        <span class="translation-shell__brand-copy">
          <strong>{{ t('translation.appName') }}</strong>
          <small>{{ t('translation.appSubtitle') }}</small>
        </span>
      </header>

      <Button class="translation-shell__create" variant="primary" @click="emit('create-project')">
        <Icon name="plus" size="md" />
        {{ t('translation.projects.create') }}
      </Button>

      <nav class="translation-shell__nav" :aria-label="t('translation.appName')">
        <button
          v-for="item in mainItems"
          :key="item.view"
          class="translation-shell__nav-item"
          :class="{ 'is-active': activeView === item.view }"
          type="button"
          :aria-current="activeView === item.view ? 'page' : undefined"
          @click="emit('navigate', item.view)"
        >
          <Icon :name="item.icon" size="md" />
          <span>{{ t(`translation.nav.${item.view}`) }}</span>
          <Badge
            v-if="item.count === 'projects' && projectCount > 0"
            class="translation-shell__nav-badge"
            size="sm"
          >
            {{ projectCount }}
          </Badge>
          <Badge
            v-else-if="item.count === 'issues' && issueCount > 0"
            class="translation-shell__nav-badge"
            size="sm"
            variant="warning"
          >
            {{ issueCount }}
          </Badge>
          <Badge
            v-else-if="item.view === 'run' && running"
            class="translation-shell__nav-badge"
            size="sm"
            variant="info"
            dot
          >
            {{ t('translation.nav.running') }}
          </Badge>
        </button>
        <button
          class="translation-shell__nav-item translation-shell__mobile-settings"
          :class="{ 'is-active': activeView === 'settings' }"
          type="button"
          :aria-current="activeView === 'settings' ? 'page' : undefined"
          @click="emit('navigate', 'settings')"
        >
          <Icon name="settings" size="md" />
          <span>{{ t('translation.nav.settings') }}</span>
        </button>
      </nav>

      <footer class="translation-shell__footer">
        <button
          class="translation-shell__nav-item"
          :class="{ 'is-active': activeView === 'settings' }"
          type="button"
          :aria-current="activeView === 'settings' ? 'page' : undefined"
          @click="emit('navigate', 'settings')"
        >
          <Icon name="settings" size="md" />
          <span>{{ t('translation.nav.settings') }}</span>
        </button>
        <button
          class="translation-shell__nav-item translation-shell__exit"
          type="button"
          :title="t('translation.exit.title')"
          @click="emit('exit')"
        >
          <Icon name="power" size="md" />
          <span>{{ t('translation.exit.action') }}</span>
        </button>
      </footer>
    </aside>

    <main class="translation-shell__content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.translation-shell {
  display: grid;
  grid-template-columns: var(--p-sidebar-w) minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}

.translation-shell__sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--color-sidebar-bg);
  border-right: 1px solid var(--color-line);
}

.translation-shell__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
}

.translation-shell__brand-mark {
  display: inline-grid;
  place-items: center;
  width: var(--space-8);
  height: var(--space-8);
  flex: none;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}

.translation-shell__brand-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.translation-shell__brand-copy strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.translation-shell__brand-copy small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.translation-shell__create {
  margin: 0 var(--space-3) var(--space-4);
}

.translation-shell__nav {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0 var(--space-3);
  overflow-y: auto;
}

.translation-shell__nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--space-8);
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}

.translation-shell__nav-item:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.translation-shell__nav-item:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.translation-shell__nav-item.is-active {
  background: var(--color-selected);
  color: var(--color-text);
}

.translation-shell__nav-badge {
  margin-left: auto;
}

.translation-shell__mobile-settings {
  display: none;
}

.translation-shell__footer {
  padding: var(--space-3);
  border-top: 1px solid var(--color-line);
}

.translation-shell__content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 640px) {
  .translation-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .translation-shell__sidebar {
    grid-row: 2;
    flex-direction: row;
    border-top: 1px solid var(--color-line);
    border-right: 0;
  }

  .translation-shell__brand,
  .translation-shell__create,
  .translation-shell__footer {
    display: none;
  }

  .translation-shell__nav {
    flex-direction: row;
    justify-content: space-around;
    padding: var(--space-1);
    overflow: visible;
  }

  .translation-shell__nav-item {
    min-width: 0;
    justify-content: center;
  }

  .translation-shell__mobile-settings {
    display: flex;
  }

  .translation-shell__nav-item span:not(.translation-shell__nav-badge) {
    display: none;
  }

  .translation-shell__nav-badge {
    display: none;
  }

  .translation-shell__content {
    grid-row: 1;
  }
}
</style>
