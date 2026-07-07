import dotenv from "dotenv";
import { createButterbaseChatCompletion, getButterbaseConfig } from "../server/butterbaseAi.js";

dotenv.config({ override: true });

const prompt =
  process.argv.slice(2).join(" ") ||
  "Return JSON for one simple dinner recipe with keys name, ingredients, steps, and why_it_matches.";

try {
  const result = await createButterbaseChatCompletion({
    messages: [
      {
        role: "system",
        content:
          "You are bepgraph's recipe extraction and meal planning agent. Keep answers concise and structured.",
      },
      { role: "user", content: prompt },
    ],
    maxTokens: 500,
    temperature: 0.2,
  });

  console.log(JSON.stringify({ model: getButterbaseConfig().model, response: result.content }, null, 2));
} catch (error) {
  console.error("Butterbase model test failed:");
  console.error(error.message);
  process.exit(1);
}
