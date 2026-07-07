import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { RocketRideClient } from "rocketride";

dotenv.config({ override: true });

const auth = process.env.ROCKETRIDE_APIKEY ?? process.env.ROCKETRIDE_API_KEY;
const uri = process.env.ROCKETRIDE_URI ?? "https://api.rocketride.ai";
const filepath = process.env.ROCKETRIDE_PIPE_FILE ?? "pipelines/fetch_scrape_extract.pipe";
const inputPath = process.env.ROCKETRIDE_TEST_INPUT ?? "test-fixtures/recipe-link.json";

if (!auth) {
  console.error("Missing ROCKETRIDE_APIKEY or ROCKETRIDE_API_KEY in .env");
  process.exit(1);
}

const client = new RocketRideClient({
  auth,
  uri,
  requestTimeout: 120000,
  onEvent: async (event) => {
    console.log("event:", event.event, event.body ?? "");
  },
});

try {
  const input = await readFile(inputPath, "utf8");
  await client.connect();
  const { token } = await client.use({ filepath });
  console.log("Pipeline token:", token);

  const result = await client.send(
    token,
    input,
    { name: inputPath.split("/").pop() ?? "input.json" },
    "application/json",
  );
  console.log("Pipeline result:");
  console.log(JSON.stringify(result, null, 2));

  const status = await client.getTaskStatus(token);
  console.log("Task status:");
  console.log(JSON.stringify(status, null, 2));

  await client.terminate(token);
} catch (error) {
  console.error("RocketRide .pipe test failed:");
  console.error(error.message);
  if (String(error.message).includes("Unexpected server response: 200")) {
    console.error("For RocketRide Cloud, set ROCKETRIDE_URI=https://api.rocketride.ai");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
