<!-- apps/batch-translating-web/src/components/ui/SegmentedControl.vue -->
<!-- Design-system §03 SegmentedControl: 2-4 mutually exclusive options. -->
<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  size?: 'sm' | 'md';
  ariaLabel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const group = ref<HTMLElement | null>(null);

async function moveSelection(event: KeyboardEvent, index: number): Promise<void> {
  let next = index;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    next = (index + 1) % props.options.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    next = (index - 1 + props.options.length) % props.options.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = props.options.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const option = props.options[next];
  if (!option) return;
  emit('update:modelValue', option.value);
  await nextTick();
  group.value?.querySelectorAll<HTMLButtonElement>('.ui-seg__item')[next]?.focus();
}
</script>

<template>
  <div
    ref="group"
    class="ui-seg"
    :class="`ui-seg--${size ?? 'md'}`"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <button
      v-for="(opt, index) in options"
      :key="opt.value"
      class="ui-seg__item"
      :class="{ 'is-on': opt.value === modelValue }"
      type="button"
      role="radio"
      :aria-checked="opt.value === modelValue"
      :tabindex="opt.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', opt.value)"
      @keydown="moveSelection($event, index)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
}
.ui-seg__item {
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  cursor: pointer;
  line-height: 1;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-seg--md .ui-seg__item { padding: 5px var(--space-3); font-size: var(--text-sm); }
.ui-seg--sm .ui-seg__item { height: 24px; padding: 0 var(--space-2); font-size: var(--text-sm); }
.ui-seg__item:hover:not(.is-on) { color: var(--color-text); }
.ui-seg__item.is-on { background: var(--color-surface-raised); color: var(--color-text); box-shadow: var(--shadow-xs); }
.ui-seg__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
</style>
