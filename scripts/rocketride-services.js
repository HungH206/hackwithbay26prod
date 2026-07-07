import dotenv from "dotenv";
import { RocketRideClient } from "rocketride";

dotenv.config({ override: true });

const auth = process.env.ROCKETRIDE_APIKEY ?? process.env.ROCKETRIDE_API_KEY;
const uri = process.env.ROCKETRIDE_URI ?? "https://api.rocketride.ai";

if (!auth) {
  console.error("Missing ROCKETRIDE_APIKEY or ROCKETRIDE_API_KEY in .env");
  process.exit(1);
}

const client = new RocketRideClient({
  auth,
  uri,
  requestTimeout: 30000,
});

try {
  await client.connect();
  console.log("Connected:", client.getConnectionInfo());
  const services = await client.getServices();
  console.log("Available services:");
  console.log(Object.keys(services).sort().join("\n"));
} catch (error) {
  console.error("RocketRide services test failed:");
  console.error(error.message);
  if (String(error.message).includes("Unexpected server response: 200")) {
    console.error("This usually means ROCKETRIDE_URI points to the website, not the RocketRide API engine.");
    console.error("For RocketRide Cloud, set ROCKETRIDE_URI=https://api.rocketride.ai");
  }
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => {});
}
