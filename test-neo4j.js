import dotenv from "dotenv";
import neo4j from "neo4j-driver";

dotenv.config({ override: true });

const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;

if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
  console.error("Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD in .env");
  process.exit(1);
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

try {
  const serverInfo = await driver.getServerInfo();
  console.log("Connection established");
  console.log({
    address: serverInfo.address,
    agent: serverInfo.agent,
    protocolVersion: serverInfo.protocolVersion,
  });
} catch (error) {
  if (error.code === "Neo.ClientError.Security.Unauthorized") {
    console.error("Neo4j rejected the credentials.");
    console.error("Check NEO4J_USER and NEO4J_PASSWORD in .env.");
    console.error(`Current URI: ${NEO4J_URI}`);
    console.error(`Current user: ${NEO4J_USER}`);
    process.exitCode = 1;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await driver.close();
}
