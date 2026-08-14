<!-- apps/batch-translating-web/src/components/dialogs/ConfigureProviderDialog.vue -->
<!-- Model / Provider API configuration dialog (Custom / OpenAI / Anthropic / OneAPI / NewAPI). -->
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import Banner from '../ui/Banner.vue';

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

const PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI 兼容接口 (NewAPI / OneAPI / 通用大模型网关)' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'google-genai', label: 'Google Gemini' },
];

/** Default context window (tokens) applied to every fetched model when the
 *  provider is saved. Users can adjust it per model later in the provider
 *  management dialog (设置 → 提供商管理). */
const DEFAULT_CONTEXT_SIZE = 200_000;

const baseUrlPlaceholder = computed(() => {
  if (form.type === 'anthropic') return 'https://api.anthropic.com/v1 (留空使用官方默认)';
  if (form.type === 'google-genai') return 'https://generativelanguage.googleapis.com/v1beta (留空使用官方默认)';
  return 'https://your-api-gateway.com/v1 (例如 NewAPI / OneAPI 提供的 Base URL)';
});

/** Provider id used when creating the provider (daemon requires a unique id). */
function newProviderId(): string {
  return `provider-${Date.now().toString(36)}`;
}

async function fetchUpstreamModels(): Promise<string[]> {
  errorMsg.value = '';
  successMsg.value = '';
  fetchedModels.value = [];

  const rawBase = form.baseUrl.trim();
  const apiKey = form.apiKey.trim();

  let targetUrl = '';
  if (rawBase) {
    targetUrl = rawBase.replace(/\/+$/, '');
    if (!targetUrl.endsWith('/models') && !targetUrl.endsWith('/v1')) {
      targetUrl = `${targetUrl}/v1/models`;
    } else if (targetUrl.endsWith('/v1')) {
      targetUrl = `${targetUrl}/models`;
    }
  } else {
    if (form.type === 'anthropic') targetUrl = 'https://api.anthropic.com/v1/models';
    else if (form.type === 'google-genai') targetUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    else targetUrl = 'https://api.openai.com/v1/models';
  }

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
    throw new Error(`上游接口响应异常 (${response.status}): ${errorBody || response.statusText}`);
  }

  const data = await response.json() as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
  const list = data.data || data.models || [];
  const modelIds = list
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));

  return modelIds;
}

async function onTestAndFetch(): Promise<void> {
  if (!form.apiKey.trim() && form.type !== 'custom') {
    errorMsg.value = '请先填写 API Key';
    return;
  }
  testing.value = true;
  errorMsg.value = '';
  try {
    const list = await fetchUpstreamModels();
    fetchedModels.value = list;
    if (list.length > 0) {
      selectedDefaultModel.value = list[0] ?? '';
      successMsg.value = `成功连接！已获取到 ${list.length} 个可用模型。`;
    } else {
      successMsg.value = '连接成功，但上游返回的模型列表为空。';
    }
  } catch (err: unknown) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    testing.value = false;
  }
}

async function onSave(): Promise<void> {
  if (!form.apiKey.trim() && form.type !== 'custom') {
    errorMsg.value = '请填写 API Key';
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
      baseUrl: form.baseUrl.trim(),
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
    :title="'配置模型服务 (API / Base URL)'"
    size="lg"
    @close="onClose"
  >
    <div class="config-provider-form">
      <p class="config-provider-hint">
        连接您的 AI 模型接口服务（如 OpenAI 兼容接口、OneAPI、NewAPI 或各大模型官方服务）。应用会自动拉取上游模型列表。
      </p>

      <Banner v-if="errorMsg" variant="danger" class="mb-4">
        {{ errorMsg }}
      </Banner>

      <Banner v-if="successMsg" variant="info" class="mb-4">
        {{ successMsg }}
      </Banner>

      <Field label="接口类型 / 协议">
        <Select v-model="form.type">
          <option v-for="pt in PROVIDER_TYPES" :key="pt.value" :value="pt.value">
            {{ pt.label }}
          </option>
        </Select>
      </Field>

      <Field label="服务地址 (Base URL)" hint="请填写 API 服务基础地址。">
        <Input
          v-model="form.baseUrl"
          :placeholder="baseUrlPlaceholder"
        />
      </Field>

      <Field label="API Key (密钥)" hint="您的接口身份凭证。">
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
          测试连接并自动获取模型列表
        </Button>
      </div>

      <Field
        v-if="fetchedModels.length > 0"
        label="已探测到的上游模型"
        :hint="`共获取到 ${fetchedModels.length} 个模型。上下文窗口默认 200k tokens，保存后可在 设置 → 提供商管理 中调整。`"
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
          取消
        </Button>
        <Button variant="primary" :loading="saving" @click="onSave">
          保存并启用
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
