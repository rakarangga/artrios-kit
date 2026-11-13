// Provider catalog for Settings > Model (one profile per
// provider with its base URL and key variable, so the user picks a name instead of typing a URL).
// Only OpenAI-compatible endpoints: that is the one wire format this app speaks (transport chat_completions).
export const CATALOG = [
  { id: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', key_env: 'OPENROUTER_API_KEY', keys_url: 'https://openrouter.ai/keys', note: 'Hundreds of models behind one key; the model list carries prices and context windows.' },
  { id: 'anthropic-api', label: 'Anthropic API', base_url: 'https://api.anthropic.com/v1', key_env: 'ANTHROPIC_API_KEY', keys_url: 'https://console.anthropic.com/settings/keys', note: 'Claude through Anthropic\'s OpenAI-compatible endpoint. Type the model id by hand (e.g. claude-sonnet-5-5) if the list stays empty.' },
  { id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', key_env: 'OPENAI_API_KEY', keys_url: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', key_env: 'DEEPSEEK_API_KEY', keys_url: 'https://platform.deepseek.com/api_keys' },
  { id: 'gemini', label: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', key_env: 'GEMINI_API_KEY', keys_url: 'https://aistudio.google.com/apikey' },
  { id: 'xai', label: 'xAI (Grok)', base_url: 'https://api.x.ai/v1', key_env: 'XAI_API_KEY', keys_url: 'https://console.x.ai' },
  { id: 'nous', label: 'Nous Portal', base_url: 'https://inference-api.nousresearch.com/v1', key_env: 'NOUS_API_KEY', keys_url: 'https://portal.nousresearch.com' },
  { id: 'zai', label: 'Z.AI (GLM)', base_url: 'https://api.z.ai/api/paas/v4', key_env: 'ZAI_API_KEY', keys_url: 'https://z.ai' },
  { id: 'nvidia', label: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', key_env: 'NVIDIA_API_KEY', keys_url: 'https://build.nvidia.com' },
  { id: 'fireworks', label: 'Fireworks', base_url: 'https://api.fireworks.ai/inference/v1', key_env: 'FIREWORKS_API_KEY', keys_url: 'https://fireworks.ai' },
  { id: 'deepinfra', label: 'DeepInfra', base_url: 'https://api.deepinfra.com/v1/openai', key_env: 'DEEPINFRA_API_KEY', keys_url: 'https://deepinfra.com' },
  { id: 'huggingface', label: 'Hugging Face', base_url: 'https://router.huggingface.co/v1', key_env: 'HF_TOKEN', keys_url: 'https://huggingface.co/settings/tokens' },
  { id: 'novita', label: 'Novita', base_url: 'https://api.novita.ai/openai/v1', key_env: 'NOVITA_API_KEY', keys_url: 'https://novita.ai' },
  { id: 'ai-gateway', label: 'Vercel AI Gateway', base_url: 'https://ai-gateway.vercel.sh/v1', key_env: 'AI_GATEWAY_API_KEY', keys_url: 'https://vercel.com/ai-gateway' },
  { id: 'dashscope', label: 'Alibaba Qwen (DashScope)', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key_env: 'DASHSCOPE_API_KEY', keys_url: 'https://bailian.console.alibabacloud.com' },
  { id: 'ollama-cloud', label: 'Ollama Cloud', base_url: 'https://ollama.com/v1', key_env: 'OLLAMA_API_KEY', keys_url: 'https://ollama.com/settings/keys' },
  { id: 'ollama', label: 'Ollama (this PC)', base_url: 'http://127.0.0.1:11434/v1', key_env: '', local: true, note: 'No key: models you pulled with ollama pull.' },
  { id: 'lmstudio', label: 'LM Studio (this PC)', base_url: 'http://127.0.0.1:1234/v1', key_env: '', local: true, note: 'No key: start the LM Studio server first.' },
];

// The CLI takes aliases; the full ids change per release, so the aliases are the stable choice.
export const CLAUDE_MODELS = [
  { id: 'sonnet', name: 'Sonnet', note: 'routine work' },
  { id: 'opus', name: 'Opus', note: 'design, audits, hard debugging' },
  { id: 'haiku', name: 'Haiku', note: 'light and fast' },
  { id: 'fable', name: 'Fable', note: 'latest' },
];

// The Codex CLI picks its own default (the plan's best model); these are only suggestions for the picker.
export const CODEX_MODELS = [
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', note: 'coding work' },
  { id: 'gpt-5.1', name: 'GPT-5.1', note: 'general' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', note: 'light and fast' },
];

// Anthropic's endpoint rejects requests without this version header (HTTP 400).
export const extraHeaders = (base_url) => (/(^|\/\/)api\.anthropic\.com/.test(String(base_url)) ? { 'anthropic-version': '2023-06-01' } : {});
