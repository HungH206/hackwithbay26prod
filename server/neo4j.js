import neo4j from "neo4j-driver";

let driver;

export function isNeo4jConfigured() {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USER && process.env.NEO4J_PASSWORD);
}

export function getDriver() {
  if (driver) return driver;

  const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;
  if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
    throw new Error("Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD");
  }

  driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  return driver;
}

export async function closeDriver() {
  if (!driver) return;
  await driver.close();
  driver = undefined;
}

export function toNative(value) {
  if (neo4j.isInt(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map(toNative);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toNative(item)]));
  }
  return value;
}
