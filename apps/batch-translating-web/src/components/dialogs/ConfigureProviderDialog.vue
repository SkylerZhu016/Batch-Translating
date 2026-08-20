<!-- apps/batch-translating-web/src/components/dialogs/ConfigureProviderDialog.vue -->
<!-- Model / Provider API configuration dialog (Custom / OpenAI / Anthropic / OneAPI / NewAPI). -->
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import Banner from '../ui/Banner.vue';
import { normalizeProviderBaseUrl, providerModelsUrl } from '../../lib/providerBaseUrl';

const props = withDefaults(defineProps<{
  open: boolean;
  initialType?: string;
  initialBaseUrl?: string;
  initialApiKey?: string;
}>(), {
  open: true,
  initialType: 'openai',
  initialBaseUrl: '',
  initialApiKey: '',
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  success: [config: {
    id: string;
    type: string;
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    models: Array<{ model: string; maxContextSize?: number }>;
  }];
  close: [];
}>();
const { t } = useI18n();
const modelCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

const form = reactive({
  type: props.initialType || 'openai',
  baseUrl: props.initialBaseUrl || '',
  apiKey: props.initialApiKey || '',
});

const testing = ref(false);
const saving = ref(false);
const errorMsg = ref('');
const successMsg = ref('');
const fetchedModels = ref<string[]>([]);
const selectedDefaultModel = ref('');

const providerTypes = computed(() => [
  { value: 'openai', label: t('translation.providerConfig.typeOpenAi') },
  { value: 'anthropic', label: t('translation.providerConfig.typeAnthropic') },
  { value: 'google-genai', label: t('translation.providerConfig.typeGoogle') },
]);

/** Default context window (tokens) applied to every fetched model when the
 *  provider is saved. Users can adjust it per model later in the provider
 *  management dialog (设置 → 提供商管理). */
const DEFAULT_CONTEXT_SIZE = 200_000;

const baseUrlPlaceholder = computed(() => {
  if (form.type === 'anthropic') return t('translation.providerConfig.anthropicPlaceholder');
  if (form.type === 'google-genai') return t('translation.providerConfig.googlePlaceholder');
  return t('translation.providerConfig.openAiPlaceholder');
});

/** Provider id used when creating the provider (daemon requires a unique id). */
function newProviderId(): string {
  return `provider-${Date.now().toString(36)}`;
}

async function fetchUpstreamModels(): Promise<string[]> {
  errorMsg.value = '';
  successMsg.value = '';
  fetchedModels.value = [];

  const apiKey = form.apiKey.trim();
  const targetUrl = providerModelsUrl(form.type, form.baseUrl);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    if (form.type === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  const response = await fetch(targetUrl, { method: 'GET', headers });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(t('translation.providerConfig.upstreamError', {
      status: response.status,
      detail: errorBody || response.statusText,
    }));
  }

  const data = await response.json() as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
  const list = data.data || data.models || [];
  const modelIds = list
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .sort((left, right) => modelCollator.compare(left, right));

  return modelIds;
}

async function onTestAndFetch(): Promise<void> {
  if (!form.apiKey.trim() && form.type !== 'custom') {
    errorMsg.value = t('translation.providerConfig.apiKeyFirst');
    return;
  }
  testing.value = true;
  errorMsg.value = '';
  try {
    const list = await fetchUpstreamModels();
    fetchedModels.value = list;
    if (list.length > 0) {
      selectedDefaultModel.value = list[0] ?? '';
      successMsg.value = t('translation.providerConfig.connectedModels', { count: list.length });
    } else {
      successMsg.value = t('translation.providerConfig.connectedEmpty');
    }
  } catch (err: unknown) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    testing.value = false;
  }
}

async function onSave(): Promise<void> {
  if (!form.apiKey.trim() && form.type !== 'custom') {
    errorMsg.value = t('translation.providerConfig.apiKeyRequired');
    return;
  }
  saving.value = true;
  errorMsg.value = '';

  try {
    let models = fetchedModels.value;
    if (models.length === 0) {
      try {
        models = await fetchUpstreamModels();
        fetchedModels.value = models;
      } catch (err) {
        // 无法获取模型列表就没有可用的默认模型，应用无法就绪 —— 中止保存，
        // 引导用户先用「测试连接」排查地址/密钥。
        errorMsg.value = err instanceof Error ? err.message : String(err);
        return;
      }
    }
    // The daemon needs a default model for the app to become ready; fall back
    // to the first fetched model when the user never opened the picker.
    if (models.length > 0 && !selectedDefaultModel.value) {
      selectedDefaultModel.value = models[0] ?? '';
    }

    emit('success', {
      id: newProviderId(),
      type: form.type,
      baseUrl: normalizeProviderBaseUrl(form.type, form.baseUrl) ?? '',
      apiKey: form.apiKey.trim(),
      defaultModel: selectedDefaultModel.value,
      models: models.map((model) => ({ model, maxContextSize: DEFAULT_CONTEXT_SIZE })),
    });
    emit('update:open', false);
    emit('close');
  } catch (err: unknown) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function onClose(): void {
  emit('update:open', false);
  emit('close');
}
</script>

<template>
  <Dialog
    :open="open"
    :title="t('translation.providerConfig.title')"
    size="lg"
    @close="onClose"
  >
    <div class="config-provider-form">
      <p class="config-provider-hint">
        {{ t('translation.providerConfig.description') }}
      </p>

      <Banner v-if="errorMsg" variant="danger" class="mb-4">
        {{ errorMsg }}
      </Banner>

      <Banner v-if="successMsg" variant="info" class="mb-4">
        {{ successMsg }}
      </Banner>

      <Field :label="t('translation.providerConfig.protocol')">
        <Select v-model="form.type">
          <option v-for="pt in providerTypes" :key="pt.value" :value="pt.value">
            {{ pt.label }}
          </option>
        </Select>
      </Field>

      <Field
        :label="t('translation.providerConfig.baseUrl')"
        :hint="t('translation.providerConfig.baseUrlHint')"
      >
        <Input
          v-model="form.baseUrl"
          :placeholder="baseUrlPlaceholder"
        />
      </Field>

      <Field
        :label="t('translation.providerConfig.apiKey')"
        :hint="t('translation.providerConfig.apiKeyHint')"
      >
        <Input
          v-model="form.apiKey"
          type="password"
          placeholder="sk-..."
        />
      </Field>

      <div class="test-row">
        <Button
          variant="secondary"
          :loading="testing"
          @click="onTestAndFetch"
        >
          <Icon name="refresh" size="sm" />
          {{ t('translation.providerConfig.testConnection') }}
        </Button>
      </div>

      <Field
        v-if="fetchedModels.length > 0"
        :label="t('translation.providerConfig.detectedModels')"
        :hint="t('translation.providerConfig.detectedModelsHint', { count: fetchedModels.length })"
      >
        <Select v-model="selectedDefaultModel">
          <option v-for="m in fetchedModels" :key="m" :value="m">
            {{ m }}
          </option>
        </Select>
      </Field>
    </div>

    <template #foot>
      <div class="dialog-actions">
        <Button variant="secondary" @click="onClose">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" :loading="saving" @click="onSave">
          {{ t('translation.providerConfig.saveEnable') }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.config-provider-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.config-provider-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.test-row {
  display: flex;
  justify-content: flex-start;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
.mb-4 {
  margin-bottom: var(--space-2);
}
</style>
