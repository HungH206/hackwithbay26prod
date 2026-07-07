import dotenv from "dotenv";
import { Answer, Question, RocketRideClient } from "rocketride";

dotenv.config({ override: true });

const auth = process.env.ROCKETRIDE_APIKEY ?? process.env.ROCKETRIDE_API_KEY;
const uri = process.env.ROCKETRIDE_URI ?? "https://api.rocketride.ai";
const filepath =
  process.env.ROCKETRIDE_CHAT_PIPE_FILE ??
  process.env.ROCKETRIDE_AGENT_PIPE_FILE ??
  "pipelines/recipe_agent.pipe";
const prompt =
  process.argv.slice(2).join(" ") ||
  "Given pantry items rice, tofu, spinach, garlic, and soy sauce, return the best recipe recommendation as JSON.";

if (!auth) {
  console.error("Missing ROCKETRIDE_APIKEY or ROCKETRIDE_API_KEY in .env");
  process.exit(1);
}

const client = new RocketRideClient({ auth, uri, requestTimeout: 120000 });

try {
  await client.connect();
  const { token } = await client.use({ filepath });
  console.log("Pipeline token:", token);

  const question = new Question({ expectJson: true });
  question.addInstruction(
    "Output",
    "Return JSON with keys: recipe_name, reason, missing_ingredients, confidence, source.",
  );
  question.addContext({
    app: "bepgraph",
    model: process.env.BUTTERBASE_AI_MODEL ?? "openai/gpt-5-nano",
  });
  question.addQuestion(prompt);

  const response = await client.chat({ token, question });
  const answerText = response?.data?.answer ?? response?.answers?.[0] ?? response?.answer;
  console.log("Raw answer:");
  console.log(answerText ?? JSON.stringify(response, null, 2));

  if (answerText) {
    console.log("Parsed JSON:");
    console.log(JSON.stringify(Answer.parseJson(answerText), null, 2));
  }

  await client.terminate(token);
} catch (error) {
  console.error("RocketRide agent chat test failed:");
  console.error(error.message);
  if (String(error.message).includes("Unexpected server response: 200")) {
    console.error("For RocketRide Cloud, set ROCKETRIDE_URI=https://api.rocketride.ai");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
