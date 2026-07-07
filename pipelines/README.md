# RocketRide Pipelines

Put RocketRide `.pipe` files here after creating them in the RocketRide IDE extension.

Expected files for bepgraph:

- `fetch_scrape_extract.pipe`
- `recipe_agent.pipe`

`fetch_scrape_extract.pipe` accepts:

```json
{
  "url": "https://example.com/recipe",
  "model": "openai/gpt-5-nano"
}
```

Expected output:

```json
{
  "recipe": { "name": "Recipe name", "author": "Author" },
  "ingredients": [{ "name": "ingredient", "quantity": "1", "unit": "cup" }],
  "steps": [{ "order": 1, "text": "Do the first step." }],
  "sources": [{ "url": "https://example.com/recipe", "type": "webpage" }]
}
```

`recipe_agent.pipe` accepts chat questions and gives the RocketRide agent access to:

- Butterbase GPT-5 Nano through the OpenAI-compatible model node
- Neo4j through the read-only `db_neo4j` tool node
- Butterbase MCP tools through `tool_mcp_client`
