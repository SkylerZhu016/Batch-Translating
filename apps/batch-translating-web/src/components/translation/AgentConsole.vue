<!-- apps/batch-translating-web/src/components/translation/AgentConsole.vue -->
<!-- Agent console: live stream of the selected project's agent turns — every
     assistant message, tool call (name + input) and tool result, exactly as
     the model works through the stage. Built for users and debuggers to tell
     "model still thinking" from "model stuck". -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppMessage, AppMessageContent } from '../../api/types';
import { isDisplayableConversationMessage } from '../../lib/messageVisibility';
import Badge from '../ui/Badge.vue';
import Icon from '../ui/Icon.vue';
import CorrectionComposer from './CorrectionComposer.vue';

const { t } = useI18n();

const props = defineProps<{
  messages: readonly AppMessage[];
  /** Whether the underlying session has a live turn (for a pulse hint). */
  running?: boolean;
  /** Correction command draft (two-way, bottom composer). */
  commandValue: string;
  /** True while a correction submission is in flight. */
  busy?: boolean;
  /** The main conversation has a submitted prompt or active turn; manual
   * compaction is only safe after that work reaches a terminal boundary. */
  conversationBusy?: boolean;
  /** The daemon is currently compacting this session. */
  compacting?: boolean;
}>();

const emit = defineEmits<{
  'update:commandValue': [value: string];
  send: [];
  compact: [];
}>();

const scrollRef = ref<HTMLElement | null>(null);
const displayMessages = computed(() => props.messages.filter(isDisplayableConversationMessage));
const compactDisabled = computed(() => (
  props.conversationBusy === true
  || props.compacting === true
  || displayMessages.value.length === 0
));
const compactTitle = computed(() => {
  if (props.compacting) return t('translation.agentConsole.compacting');
  if (props.conversationBusy) return t('translation.agentConsole.compactAfterTurn');
  if (displayMessages.value.length === 0) return t('translation.agentConsole.compactEmpty');
  return t('translation.agentConsole.compactHint');
});

/** Show the manual "jump to bottom" affordance once the user has scrolled up. */
const showScrollToBottom = ref(false);
const followingLatest = ref(true);
const SCROLL_NEAR_BOTTOM_PX = 48;

function updateScrollToBottomState(): void {
  const el = scrollRef.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
  followingLatest.value = nearBottom;
  showScrollToBottom.value = !nearBottom;
}

function scrollConsoleToBottom(): void {
  const el = scrollRef.value;
  if (!el) return;
  followingLatest.value = true;
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

onMounted(async () => {
  // The console is v-if mounted whenever the view is switched in.
  // Reposition to the latest activity on every entrance.
  await nextTick();
  const el = scrollRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    updateScrollToBottomState();
  }
});

watch(
  () => displayMessages.value.length,
  async () => {
    const shouldFollow = followingLatest.value;
    await nextTick();
    const el = scrollRef.value;
    if (!el) return;
    if (shouldFollow) {
      el.scrollTop = el.scrollHeight;
      followingLatest.value = true;
      showScrollToBottom.value = false;
    } else {
      // Preserve the user's reading position and make new activity discoverable.
      showScrollToBottom.value = true;
    }
  },
);

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/** Compact one-line summary of a tool input/output (truncated). */
function summarize(value: unknown, max = 300): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

/** Full readable output shown only after the user expands a tool result. */
function formatDetail(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function roleLabel(role: AppMessage['role']): string {
  switch (role) {
    case 'user': return t('translation.agentConsole.user');
    case 'assistant': return t('translation.agentConsole.assistant');
    case 'tool': return t('translation.agentConsole.tool');
    case 'system': return 'System';
  }
}

function roleVariant(role: AppMessage['role']): 'info' | 'success' | 'neutral' {
  switch (role) {
    case 'user': return 'info';
    case 'assistant': return 'success';
    default: return 'neutral';
  }
}

function isText(block: AppMessageContent): block is Extract<AppMessageContent, { type: 'text' }> {
  return block.type === 'text';
}
function isToolUse(block: AppMessageContent): block is Extract<AppMessageContent, { type: 'toolUse' }> {
  return block.type === 'toolUse';
}
function isToolResult(block: AppMessageContent): block is Extract<AppMessageContent, { type: 'toolResult' }> {
  return block.type === 'toolResult';
}
function isThinking(block: AppMessageContent): block is Extract<AppMessageContent, { type: 'thinking' }> {
  return block.type === 'thinking';
}

function blockKey(block: AppMessageContent, index: number): string {
  return block.type === 'toolUse' || block.type === 'toolResult'
    ? `${block.type}:${block.toolCallId}`
    : `${block.type}:${index}`;
}

/** Tool results by call id — resolves whether a toolUse has an answer yet. */
const resultByCallId = ref<Map<string, AppMessageContent>>(new Map());
watch(
  () => props.messages,
  (messages) => {
    const map = new Map<string, AppMessageContent>();
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'toolResult') map.set(block.toolCallId, block);
      }
    }
    resultByCallId.value = map;
  },
  { immediate: true, deep: false },
);
</script>

<template>
  <div class="agent-console">
    <header class="agent-console__header">
      <div class="agent-console__title">
        <Icon name="terminal" size="md" />
        <h2>{{ t('translation.agentConsole.title') }}</h2>
      </div>
      <div class="agent-console__header-actions">
        <button
          type="button"
          class="agent-console__compact"
          :disabled="compactDisabled"
          :title="compactTitle"
          @click="emit('compact')"
        >
          <Icon name="archive" size="sm" />
          {{ compacting
            ? t('translation.agentConsole.compacting')
            : t('translation.agentConsole.compact') }}
        </button>
        <div class="agent-console__status">
          <span class="agent-console__live" :class="{ 'is-live': running }" />
          {{ running ? t('translation.agentConsole.live') : t('translation.agentConsole.idle') }}
        </div>
      </div>
    </header>

    <div
      ref="scrollRef"
      class="agent-console__stream"
      @scroll.passive="updateScrollToBottomState"
    >
      <p v-if="displayMessages.length === 0" class="agent-console__empty">
        {{ t('translation.agentConsole.empty') }}
      </p>

      <article
        v-for="(message, messageIndex) in displayMessages"
        :key="message.id || `${message.role}:${messageIndex}`"
        class="agent-console__message"
        :class="`agent-console__message--${message.role}`"
      >
        <header class="agent-console__msg-head">
          <Badge :variant="roleVariant(message.role)" size="sm">{{ roleLabel(message.role) }}</Badge>
          <span class="agent-console__time">{{ formatTime(message.createdAt) }}</span>
          <span v-if="message.durationMs !== undefined" class="agent-console__duration">
            {{ (message.durationMs / 1000).toFixed(1) }}s
          </span>
        </header>

        <div class="agent-console__blocks">
          <template v-for="(block, blockIndex) in message.content" :key="blockKey(block, blockIndex)">
            <!-- Plain text -->
            <p v-if="isText(block)" class="agent-console__text">{{ block.text }}</p>

            <!-- Thinking (collapsed) -->
            <details v-else-if="isThinking(block)" class="agent-console__thinking">
              <summary>{{ t('translation.agentConsole.thinking') }}</summary>
              <pre>{{ block.thinking }}</pre>
            </details>

            <!-- Tool call -->
            <details v-else-if="isToolUse(block)" class="agent-console__tool">
              <summary class="agent-console__tool-head">
                <span class="agent-console__tool-summary">
                  <Icon name="wrench" size="sm" />
                  <strong>{{ block.toolName }}</strong>
                  <span class="agent-console__tool-state">
                    {{ resultByCallId.has(block.toolCallId)
                      ? t('translation.agentConsole.toolDone')
                      : t('translation.agentConsole.toolRunning') }}
                  </span>
                </span>
              </summary>
              <pre class="agent-console__code">{{ summarize(block.input) }}</pre>
            </details>

            <!-- Tool result -->
            <details
              v-else-if="isToolResult(block)"
              class="agent-console__result"
              :class="{ 'is-error': block.isError }"
            >
              <summary class="agent-console__result-label">
                {{ block.isError ? t('translation.agentConsole.resultError') : t('translation.agentConsole.result') }}
              </summary>
              <pre class="agent-console__code">{{ formatDetail(block.output) }}</pre>
            </details>

            <!-- Other block kinds (images / files / unknown) -->
            <div v-else class="agent-console__other">
              <span>{{ block.type }}</span>
            </div>
          </template>
        </div>
      </article>
    </div>

    <button
      v-if="showScrollToBottom"
      type="button"
      class="agent-console__scroll-bottom"
      aria-label="Scroll to bottom"
      title="New activity — jump to latest"
      @click="scrollConsoleToBottom"
    >
      <Icon name="chevron-down" size="md" />
    </button>

    <div class="agent-console__composer">
      <CorrectionComposer
        :model-value="commandValue"
        :busy="busy"
        @update:model-value="emit('update:commandValue', $event)"
        @send="emit('send')"
      />
    </div>
  </div>
</template>

<style scoped>
.agent-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
  background: var(--color-bg);
}
.agent-console__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-line);
}
.agent-console__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.agent-console__title h2 {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.agent-console__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.agent-console__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.agent-console__compact {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  cursor: pointer;
}
.agent-console__compact:hover:not(:disabled) {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.agent-console__compact:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.agent-console__live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-faint);
}
.agent-console__live.is-live {
  background: var(--color-success);
  animation: agent-console-pulse 1.2s ease-in-out infinite;
}
@keyframes agent-console-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.agent-console__stream {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  font-family: var(--font-ui);
}
.agent-console__composer {
  flex: none;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--color-line);
  background: var(--color-bg);
}
.agent-console__scroll-bottom {
  position: absolute;
  right: var(--space-4);
  bottom: calc(var(--space-4) + var(--space-3) + 2rem);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--color-line);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  box-shadow: var(--shadow-md);
  z-index: var(--z-sticky);
}
.agent-console__scroll-bottom:hover {
  background: var(--color-surface-sunken);
}
.agent-console__scroll-bottom:active {
  transform: translateY(1px);
}
.agent-console__empty {
  margin: auto;
  max-width: 420px;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.agent-console__message {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: min(860px, 100%);
}
.agent-console__message--user { align-self: flex-end; }
.agent-console__message--assistant { align-self: flex-start; }
.agent-console__msg-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.agent-console__time {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
.agent-console__duration {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
.agent-console__blocks {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.agent-console__text {
  margin: 0;
  padding: var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-console__thinking {
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}
.agent-console__thinking summary {
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.agent-console__thinking pre {
  margin: var(--space-2) 0 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-console__tool,
.agent-console__result {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  overflow: hidden;
}
.agent-console__tool-head {
  display: list-item;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
}
.agent-console__tool-summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: calc(100% - var(--space-2));
  vertical-align: middle;
}
.agent-console__tool-state {
  margin-left: auto;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.agent-console__result-label {
  display: list-item;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-line);
}
.agent-console__tool:not([open]) > .agent-console__tool-head,
.agent-console__result:not([open]) > .agent-console__result-label {
  border-bottom: 0;
}
.agent-console__result.is-error {
  border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-line));
}
.agent-console__result.is-error .agent-console__result-label {
  color: var(--color-danger);
}
.agent-console__code {
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.agent-console__other {
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>
