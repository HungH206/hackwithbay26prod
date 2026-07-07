import { Question, RocketRideClient } from "rocketride";

export function isRocketRideConfigured() {
  return Boolean(
    process.env.ROCKETRIDE_APIKEY ?? process.env.ROCKETRIDE_API_KEY ?? process.env.ROCKETRIDE_ENDPOINT,
  );
}

export function getRocketRideConfig() {
  return {
    endpoint: process.env.ROCKETRIDE_ENDPOINT,
    auth: process.env.ROCKETRIDE_APIKEY ?? process.env.ROCKETRIDE_API_KEY,
    uri: process.env.ROCKETRIDE_URI ?? "https://api.rocketride.ai",
    pipeFile: process.env.ROCKETRIDE_PIPE_FILE ?? "pipelines/fetch_scrape_extract.pipe",
    chatPipeFile:
      process.env.ROCKETRIDE_CHAT_PIPE_FILE ??
      process.env.ROCKETRIDE_AGENT_PIPE_FILE ??
      "pipelines/recipe_agent.pipe",
  };
}

function getAnswerText(result) {
  return result?.data?.answer ?? result?.answers?.[0] ?? result?.answer ?? null;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractPipelinePayload(result) {
  const answerPayload = parseMaybeJson(getAnswerText(result));
  if (answerPayload) return answerPayload;

  if (result?.data?.recipe) {
    return parseMaybeJson(result.data.recipe) ?? result.data.recipe;
  }

  if (result?.data && typeof result.data === "object") return result.data;
  return result;
}

async function withRocketRideClient(callback) {
  const { auth, uri } = getRocketRideConfig();
  if (!auth) {
    throw new Error("Missing ROCKETRIDE_APIKEY or ROCKETRIDE_API_KEY");
  }

  const client = new RocketRideClient({ auth, uri, requestTimeout: 120000 });
  let token;

  try {
    await client.connect();
    const result = await callback(client, (taskToken) => {
      token = taskToken;
    });
    return result?.value ?? result;
  } finally {
    if (token) {
      await client.terminate(token).catch(() => {});
    }
    await client.disconnect().catch(() => {});
  }
}

async function runPipeFile(filepath, payload) {
  return withRocketRideClient(async (client, setToken) => {
    const { token } = await client.use({ filepath });
    setToken(token);
    const result = await client.send(
      token,
      JSON.stringify(payload),
      { name: "bepgraph-input.json" },
      "application/json",
    );

    return { token, value: extractPipelinePayload(result) };
  });
}

async function runHttpPipeline(path, payload) {
  const { endpoint } = getRocketRideConfig();
  if (!endpoint) {
    throw new Error("Missing ROCKETRIDE_ENDPOINT");
  }

  const baseUrl = endpoint.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? data.message ?? `RocketRide pipeline failed: ${response.status}`);
  }

  return data;
}

export async function runRocketRidePipeline(path, payload) {
  const { auth, pipeFile } = getRocketRideConfig();
  if (auth) {
    return runPipeFile(pipeFile, payload);
  }

  return runHttpPipeline(path, payload);
}

export async function runRocketRideAgentChat({ message, pantryItems = [], recipes = [] }) {
  const { chatPipeFile } = getRocketRideConfig();

  return withRocketRideClient(async (client, setToken) => {
    const { token } = await client.use({ filepath: chatPipeFile });
    setToken(token);
    const question = new Question({ expectJson: false });
    question.addInstruction(
      "Output",
      "Return a concise user-facing answer. Include recipe name, pantry match, missing ingredients, and source URL when available.",
    );
    question.addContext({
      app: "bepgraph",
      pantry_items: pantryItems,
      local_recipe_snapshot: recipes.map((recipe) => ({
        name: recipe.name,
        author: recipe.author,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        sources: recipe.sources,
      })),
    });
    question.addQuestion(message);

    const result = await client.chat({ token, question });
    const answerText = getAnswerText(result);

    return {
      token,
      value: {
        reply: answerText ?? JSON.stringify(result),
        raw: result,
      },
    };
  });
}
