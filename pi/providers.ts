/**
 * The providers Pi authenticates with an API key, as `docs/pi/providers.md`
 * lists them: the id Pi stores a credential under in `auth.json`, the name to
 * show, and the environment variable Pi reads when none is stored.
 */
export interface ProviderInfo {
  id: string;
  name: string;
  env: string;
  /** Where a person gets a key. */
  keysUrl?: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY", keysUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", env: "GEMINI_API_KEY", keysUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", keysUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY", keysUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", name: "xAI", env: "XAI_API_KEY", keysUrl: "https://console.x.ai" },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", keysUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", env: "MISTRAL_API_KEY", keysUrl: "https://console.mistral.ai/api-keys" },
  { id: "cerebras", name: "Cerebras", env: "CEREBRAS_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI", env: "MOONSHOT_API_KEY" },
  { id: "moonshotai-cn", name: "Moonshot AI (China)", env: "MOONSHOT_API_KEY" },
  { id: "kimi-coding", name: "Kimi For Coding", env: "KIMI_API_KEY" },
  { id: "zai", name: "ZAI Coding Plan", env: "ZAI_API_KEY" },
  { id: "zai-coding-cn", name: "ZAI Coding Plan (China)", env: "ZAI_CODING_CN_API_KEY" },
  { id: "minimax", name: "MiniMax", env: "MINIMAX_API_KEY" },
  { id: "minimax-cn", name: "MiniMax (China)", env: "MINIMAX_CN_API_KEY" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", env: "QWEN_TOKEN_PLAN_API_KEY" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)", env: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", env: "XIAOMI_API_KEY" },
  { id: "fireworks", name: "Fireworks", env: "FIREWORKS_API_KEY" },
  { id: "together", name: "Together AI", env: "TOGETHER_API_KEY" },
  { id: "huggingface", name: "Hugging Face", env: "HF_TOKEN" },
  { id: "nvidia", name: "NVIDIA NIM", env: "NVIDIA_API_KEY" },
  { id: "baseten", name: "Baseten", env: "BASETEN_API_KEY" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY" },
  { id: "opencode", name: "OpenCode Zen", env: "OPENCODE_API_KEY" },
  { id: "meta", name: "Meta", env: "META_API_KEY" },
  { id: "ant-ling", name: "Ant Ling", env: "ANT_LING_API_KEY" },
  { id: "radius", name: "Radius", env: "RADIUS_API_KEY" },
];

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** A provider's display name: the catalog's, else its id made presentable (`my-proxy` → `My Proxy`). */
export function providerName(id: string) {
  return (
    byId.get(id)?.name ??
    id
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}
