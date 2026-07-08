const defaultApiUrl = "https://api.butterbase.ai";
const defaultModel = "openai/gpt-5-nano";

export function getButterbaseConfig() {
  return {
    apiUrl: process.env.BUTTERBASE_API_URL ?? defaultApiUrl,
    appId: process.env.BUTTERBASE_APP_ID,
    apiKey: process.env.BUTTERBASE_API_KEY,
    model: process.env.BUTTERBASE_AI_MODEL ?? defaultModel,
  };
}

export function isButterbaseAiConfigured() {
  return Boolean(getButterbaseConfig().apiKey);
}

function chatCompletionsUrl({ apiUrl, appId }) {
  const baseUrl = apiUrl.replace(/\/$/, "");
  return appId
    ? `${baseUrl}/v1/${appId}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
}

export async function createButterbaseChatCompletion({
  messages,
  maxTokens = 500,
  temperature = 0.4,
  reasoningEffort,
}) {
  const config = getButterbaseConfig();

  if (!config.apiKey) {
    throw new Error("Missing BUTTERBASE_API_KEY");
  }

  const response = await fetch(chatCompletionsUrl(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      // Reasoning models (e.g. gpt-5-nano) spend tokens on hidden reasoning
      // before producing visible content; without a cap they can consume the
      // entire max_tokens budget and return an empty answer. Keep effort low
      // for this recipe-routing task.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.error?.message ?? data.message ?? `Butterbase AI failed: ${response.status}`;
    throw new Error(message);
  }

  return {
    model: config.model,
    content: data.choices?.[0]?.message?.content ?? "",
    raw: data,
  };
}
