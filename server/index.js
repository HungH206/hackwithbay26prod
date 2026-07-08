import cors from "cors";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import {
  addImport,
  addRecipe,
  listRecipes,
  queryRecipesByPantry,
  updateRecipe,
} from "./fileDatabase.js";
import {
  createButterbaseChatCompletion,
  getButterbaseConfig,
  isButterbaseAiConfigured,
} from "./butterbaseAi.js";
import { closeDriver, getDriver, isNeo4jConfigured, toNative } from "./neo4j.js";
import {
  getSpoonacularRecipe,
  normalizeSpoonacularRecipe,
  searchSpoonacularRecipes,
} from "./providers/spoonacular.js";
import {
  getRocketRideConfig,
  isRocketRideAvailable,
  isRocketRideConfigured,
  runRocketRidePipeline,
} from "./rocketride.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function sourceTypeFromUrl(url = "") {
  if (/youtube|youtu\.be|vimeo|tiktok|instagram/i.test(url)) return "video";
  if (/\.pdf($|\?)/i.test(url)) return "document";
  return "webpage";
}

function mapRecipeRecord(record) {
  return {
    id: record.get("id"),
    name: record.get("name"),
    author: record.get("author"),
    created_at: record.get("created_at"),
    ingredients: toNative(record.get("ingredients") ?? []),
    steps: toNative(record.get("steps") ?? []),
    sources: toNative(record.get("sources") ?? []),
    provider: record.get("provider") ?? null,
    external_id: record.get("external_id") ?? null,
    image_url: record.get("image_url") ?? null,
  };
}

async function saveRecipeToNeo4j(payload) {
  const recipe = payload.recipe ?? payload;
  const ingredients = payload.ingredients ?? recipe.ingredients ?? [];
  const steps = payload.steps ?? recipe.steps ?? [];
  const sources = payload.sources ?? recipe.sources ?? [];
  const recipeId = recipe.id ?? randomUUID();
  const session = getDriver().session();

  try {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `
        MERGE (r:Recipe {id: $recipeId})
        SET r.name = $recipe.name,
            r.author = $recipe.author,
            r.created_at = coalesce($recipe.created_at, datetime()),
            r.provider = $recipe.provider,
            r.external_id = $recipe.external_id,
            r.image_url = $recipe.image_url

        WITH r
        UNWIND $ingredients AS ingredient
        WITH r, ingredient WHERE ingredient.name IS NOT NULL AND trim(ingredient.name) <> ""
        MERGE (i:Ingredient {name: toLower(trim(ingredient.name))})
        MERGE (r)-[requires:REQUIRES]->(i)
        SET requires.quantity = ingredient.quantity,
            requires.unit = ingredient.unit,
            requires.original = ingredient.original,
            requires.external_id = ingredient.external_id

        WITH DISTINCT r
        UNWIND $steps AS step
        WITH r, step WHERE step.text IS NOT NULL AND trim(step.text) <> ""
        MERGE (s:Step {recipe_id: $recipeId, order: step.order})
        SET s.text = step.text
        MERGE (r)-[:HAS_STEP]->(s)

        WITH DISTINCT r
        UNWIND $sources AS source
        WITH r, source WHERE source.url IS NOT NULL AND trim(source.url) <> ""
        MERGE (src:Source {url: source.url})
        SET src.type = coalesce(source.type, "webpage"),
            src.title = source.title
        MERGE (r)-[:SOURCED_FROM]->(src)

        RETURN r.id AS id, r.name AS name, r.author AS author, r.created_at AS created_at
        `,
        { recipeId, recipe: { ...recipe, id: recipeId }, ingredients, steps, sources },
      ),
    );

    return toNative(result.records[0]?.toObject() ?? { id: recipeId });
  } finally {
    await session.close();
  }
}

async function saveUnifiedRecipe(payload) {
  if (!isNeo4jConfigured()) {
    return { recipe: await addRecipe(payload), source: "file" };
  }

  const savedRecipe = await saveRecipeToNeo4j(payload);
  const recipe = payload.recipe ?? payload;
  return {
    recipe: {
      ...recipe,
      ...savedRecipe,
      ingredients: (payload.ingredients ?? recipe.ingredients ?? []).map((ingredient) =>
        typeof ingredient === "string" ? ingredient : ingredient.name,
      ),
      steps: (payload.steps ?? recipe.steps ?? []).map((step) =>
        typeof step === "string" ? step : step.text,
      ),
      sources: payload.sources ?? recipe.sources ?? [],
    },
    source: "neo4j",
  };
}

function normalizeExtractedRecipe(extracted, url) {
  const recipe = Array.isArray(extracted) ? extracted.find((item) => item?.["@type"] === "Recipe") : extracted;
  const author = Array.isArray(recipe?.author) ? recipe.author[0] : recipe?.author;
  const instructions = (recipe?.recipeInstructions ?? []).flatMap((instruction) => {
    if (instruction?.itemListElement) return instruction.itemListElement;
    return instruction;
  });

  return {
    name: recipe?.name ?? "Imported Recipe Draft",
    author: typeof author === "string" ? author : author?.name ?? "Unknown author",
    ingredients: (recipe?.recipeIngredient ?? []).map((name) => ({ name })),
    steps: instructions.map((step, index) => ({
      order: index + 1,
      text: typeof step === "string" ? step : step.text ?? step.name,
    })),
    sources: [
      {
        url,
        type: sourceTypeFromUrl(url),
        title: recipe?.name ?? "Original recipe source",
      },
    ],
    created_at: new Date().toISOString(),
  };
}

function findRecipeJsonLd(html) {
  const matches = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const graph = parsed?.["@graph"];
      const candidates = Array.isArray(graph) ? graph : Array.isArray(parsed) ? parsed : [parsed];
      const recipe = candidates.find((item) => {
        const type = item?.["@type"];
        return type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
      });
      if (recipe) return recipe;
    } catch {
      // Ignore malformed structured data and keep looking.
    }
  }

  return null;
}

async function scrapeRecipeFromUrl(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "bepgraph-recipe-importer/0.1",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recipe source: ${response.status}`);
  }

  const html = await response.text();
  const recipeJsonLd = findRecipeJsonLd(html);
  if (!recipeJsonLd) {
    throw new Error("No Recipe JSON-LD found on source page");
  }

  return normalizeExtractedRecipe(recipeJsonLd, url);
}

function localAgentReply(message, pantryItems, recipes) {
  if (!pantryItems.length) {
    return "Add pantry ingredients so I can search the recipe graph for a good meal match.";
  }

  const pantry = new Set(pantryItems.map((item) => item.toLowerCase()));
  const scored = recipes
    .map((recipe) => {
      const matches = recipe.ingredients.filter((ingredient) =>
        pantry.has(String(ingredient).toLowerCase()),
      ).length;
      return { recipe, matches, total: recipe.ingredients.length };
    })
    .filter((item) => item.matches > 0)
    .sort((a, b) => b.matches - a.matches);

  if (/similar|related|like/i.test(message) && recipes.length > 1) {
    return `Similarity path: ${recipes[0].name} can be compared with ${recipes
      .slice(1)
      .map((recipe) => recipe.name)
      .join(", ")} by shared ingredient nodes.`;
  }

  if (!scored.length) {
    return "I do not see a strong pantry match yet. Add more recipes or more pantry ingredients.";
  }

  const best = scored[0];
  return `Best match: ${best.recipe.name}. It matches ${best.matches} of ${best.total} ingredient nodes from your pantry.`;
}

// Retrieve pantry-matched recipes straight from the Neo4j graph (or the file DB
// when Neo4j isn't configured). Runs in-process, so it works even when
// RocketRide's cloud cannot reach the Aura routing endpoint.
async function getGraphRecipeContext(pantryItems) {
  const pantry = pantryItems.map((item) => String(item).toLowerCase());

  if (!isNeo4jConfigured()) {
    // Prefer pantry matches, but always surface the saved collection so
    // "what recipes do I have" works even with no overlap.
    const matched = await queryRecipesByPantry(pantryItems);
    const recipes = matched.length ? matched : await listRecipes();
    return { source: "file", recipes };
  }

  const session = getDriver().session();
  try {
    // Return the whole saved collection (not just pantry matches), ranked by
    // how many pantry ingredients each recipe overlaps. This lets the model
    // both recommend matches AND answer inventory questions like "what do I
    // have". matched/matchCount tell it the overlap; 0 means no pantry match.
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (r:Recipe)
        OPTIONAL MATCH (r)-[:REQUIRES]->(i:Ingredient)
        WITH r, collect(DISTINCT i.name) AS ingredients
        WITH r, ingredients, [x IN ingredients WHERE x IN $pantry] AS matched
        OPTIONAL MATCH (r)-[:SOURCED_FROM]->(src:Source)
        WITH r, ingredients, matched, collect(DISTINCT src.url) AS sources
        RETURN r.name AS name, r.author AS author, ingredients,
               matched, size(matched) AS matchCount, size(ingredients) AS total,
               sources[0] AS source
        ORDER BY matchCount DESC, r.created_at DESC
        LIMIT 15
        `,
        { pantry },
      ),
    );
    return { source: "neo4j", recipes: result.records.map((record) => toNative(record.toObject())) };
  } finally {
    await session.close();
  }
}

// Retrieve recipe candidates from the external Spoonacular API. Keyword search
// uses the user's message, falling back to their pantry contents.
async function getSpoonacularContext(message, pantryItems) {
  const query = message?.trim() || pantryItems.join(", ");
  if (!query) return { source: "spoonacular", recipes: [] };

  const data = await searchSpoonacularRecipes({ query, number: 5 });
  const recipes = (data.results ?? []).map((result) => ({
    name: result.title,
    author: result.sourceName ?? result.creditsText ?? "Spoonacular",
    ingredients: (result.extendedIngredients ?? []).map(
      (ingredient) => ingredient.nameClean ?? ingredient.name,
    ),
    source: result.sourceUrl ?? result.spoonacularSourceUrl ?? null,
    readyInMinutes: result.readyInMinutes ?? null,
  }));
  return { source: "spoonacular", recipes };
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "bepgraph-backend",
    neo4jConfigured: isNeo4jConfigured(),
    fileDatabase: "data/recipes.json",
    butterbaseConfigured: Boolean(process.env.BUTTERBASE_API_KEY),
    butterbaseApiUrl: getButterbaseConfig().apiUrl,
    butterbaseAiModel: getButterbaseConfig().model,
    butterbaseAppScoped: Boolean(process.env.BUTTERBASE_APP_ID),
    rocketRideConfigured: isRocketRideConfigured(),
    rocketRideUri: getRocketRideConfig().uri,
    rocketRidePipeFile: getRocketRideConfig().pipeFile,
    rocketRideChatPipeFile: getRocketRideConfig().chatPipeFile,
    rocketRideEndpoint: process.env.ROCKETRIDE_ENDPOINT ? "configured" : "missing",
  });
});

app.get("/api/recipes", async (_request, response, next) => {
  if (!isNeo4jConfigured()) {
    response.json({ recipes: await listRecipes(), source: "file" });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:Recipe)
        OPTIONAL MATCH (r)-[:REQUIRES]->(i:Ingredient)
        OPTIONAL MATCH (r)-[:HAS_STEP]->(s:Step)
        OPTIONAL MATCH (r)-[:SOURCED_FROM]->(src:Source)
        WITH r,
          collect(DISTINCT i.name) AS ingredients,
          collect(DISTINCT {order: s.order, text: s.text}) AS stepObjects,
          collect(DISTINCT {url: src.url, type: src.type}) AS sources
        RETURN
          coalesce(r.id, elementId(r)) AS id,
          r.name AS name,
          r.author AS author,
          r.created_at AS created_at,
          r.provider AS provider,
          r.external_id AS external_id,
          r.image_url AS image_url,
          ingredients,
          [step IN stepObjects WHERE step.text IS NOT NULL | step.text] AS steps,
          [source IN sources WHERE source.url IS NOT NULL | source] AS sources
        ORDER BY r.created_at DESC
        LIMIT 50
      `),
    );

    response.json({ recipes: result.records.map(mapRecipeRecord) });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

app.post("/api/recipes", async (request, response, next) => {
  const payload = request.body;
  try {
    const saved = await saveUnifiedRecipe(payload);
    response.status(201).json({ ok: true, ...saved });
  } catch (error) {
    next(error);
  }
});

app.get("/api/providers/spoonacular/search", async (request, response, next) => {
  try {
    const data = await searchSpoonacularRecipes({
      query: request.query.query,
      number: request.query.number ?? 10,
    });
    response.json({
      provider: "spoonacular",
      results: data.results ?? [],
      totalResults: data.totalResults ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/providers/spoonacular/recipes/:id/save", async (request, response, next) => {
  try {
    const spoonacularRecipe = await getSpoonacularRecipe(request.params.id);
    const unifiedRecipe = normalizeSpoonacularRecipe(spoonacularRecipe);
    const saved = await saveUnifiedRecipe(unifiedRecipe);
    await addImport({
      url: unifiedRecipe.sources[0]?.url ?? spoonacularRecipe.spoonacularSourceUrl,
      status: "imported",
      source_type: "api",
      provider: "spoonacular",
      external_id: String(spoonacularRecipe.id),
      recipe_id: saved.recipe.id,
    });
    response.status(201).json({ ok: true, provider: "spoonacular", ...saved });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/recipes/:id", async (request, response, next) => {
  const { id } = request.params;
  const patch = request.body;
  const ingredients = (patch.ingredients ?? []).map((ingredient) =>
    typeof ingredient === "string" ? { name: ingredient } : ingredient,
  );
  const steps = (patch.steps ?? []).map((step, index) =>
    typeof step === "string" ? { order: index + 1, text: step } : step,
  );
  const sources = patch.sources ?? [];

  if (!isNeo4jConfigured()) {
    const updatedRecipe = await updateRecipe(id, patch);
    if (!updatedRecipe) {
      response.status(404).json({ error: "recipe not found" });
      return;
    }
    response.json({ ok: true, recipe: updatedRecipe, source: "file" });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (r:Recipe {id: $id})
        SET r.name = coalesce($name, r.name),
            r.author = coalesce($author, r.author),
            r.updated_at = datetime()

        WITH r
        OPTIONAL MATCH (r)-[oldRequires:REQUIRES]->(:Ingredient)
        DELETE oldRequires

        WITH r
        OPTIONAL MATCH (r)-[oldStepRel:HAS_STEP]->(oldStep:Step)
        DELETE oldStepRel, oldStep

        WITH r
        OPTIONAL MATCH (r)-[oldSourceRel:SOURCED_FROM]->(:Source)
        DELETE oldSourceRel

        WITH r
        CALL {
          WITH r
          UNWIND $ingredients AS ingredient
          WITH r, ingredient WHERE ingredient.name IS NOT NULL AND trim(ingredient.name) <> ""
          MERGE (i:Ingredient {name: toLower(trim(ingredient.name))})
          MERGE (r)-[requires:REQUIRES]->(i)
          SET requires.quantity = ingredient.quantity,
              requires.unit = ingredient.unit
          RETURN count(*) AS ingredientCount
        }

        WITH r
        CALL {
          WITH r
          UNWIND $steps AS step
          WITH r, step WHERE step.text IS NOT NULL AND trim(step.text) <> ""
          CREATE (s:Step {recipe_id: $id, order: step.order, text: step.text})
          MERGE (r)-[:HAS_STEP]->(s)
          RETURN count(*) AS stepCount
        }

        WITH r
        CALL {
          WITH r
          UNWIND $sources AS source
          WITH r, source WHERE source.url IS NOT NULL AND trim(source.url) <> ""
          MERGE (src:Source {url: source.url})
          SET src.type = coalesce(source.type, "webpage"),
              src.title = source.title
          MERGE (r)-[:SOURCED_FROM]->(src)
          RETURN count(*) AS sourceCount
        }

        WITH r
        OPTIONAL MATCH (r)-[:REQUIRES]->(i:Ingredient)
        OPTIONAL MATCH (r)-[:HAS_STEP]->(s:Step)
        OPTIONAL MATCH (r)-[:SOURCED_FROM]->(src:Source)
        WITH r,
          collect(DISTINCT i.name) AS ingredients,
          collect(DISTINCT {order: s.order, text: s.text}) AS stepObjects,
          collect(DISTINCT {url: src.url, type: src.type, title: src.title}) AS sources
        RETURN
          r.id AS id,
          r.name AS name,
          r.author AS author,
          r.created_at AS created_at,
          ingredients,
          [step IN stepObjects WHERE step.text IS NOT NULL | step.text] AS steps,
          [source IN sources WHERE source.url IS NOT NULL | source] AS sources
        `,
        {
          id,
          name: patch.name,
          author: patch.author,
          ingredients,
          steps,
          sources,
        },
      ),
    );

    if (!result.records.length) {
      response.status(404).json({ error: "recipe not found" });
      return;
    }

    response.json({ ok: true, recipe: mapRecipeRecord(result.records[0]) });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

app.post("/api/recipes/from-link", async (request, response) => {
  const { url } = request.body;
  if (!url) {
    response.status(400).json({ error: "url is required" });
    return;
  }

  try {
    const extractedRecipe = await scrapeRecipeFromUrl(url);
    const savedRecipe = await addRecipe(extractedRecipe);
    await addImport({
      url,
      status: "imported",
      source_type: sourceTypeFromUrl(url),
      recipe_id: savedRecipe.id,
    });
    response.status(201).json({ ok: true, recipe: savedRecipe, source: "scraped-json-ld" });
  } catch (error) {
    if (isRocketRideAvailable()) {
      try {
        const pipelineResult = await runRocketRidePipeline("/fetch_scrape_extract", {
          url,
          model: getButterbaseConfig().model,
        });
        const saved = await saveUnifiedRecipe(pipelineResult);
        await addImport({
          url,
          status: "imported",
          source_type: sourceTypeFromUrl(url),
          provider: "rocketride",
          recipe_id: saved.recipe.id,
        });
        response.status(201).json({ ok: true, ...saved, source: "rocketride" });
        return;
      } catch (pipelineError) {
        await addImport({
          url,
          status: "pipeline_failed",
          source_type: sourceTypeFromUrl(url),
          provider: "rocketride",
          error: pipelineError.message,
        });
      }
    }

    const draftRecipe = await addRecipe({
      name: "Imported Recipe Draft",
      author: "Recipe extraction pending",
      ingredients: ["ingredient nodes pending"],
      steps: ["Use Butterbase/RocketRide extraction for pages without Recipe JSON-LD."],
      sources: [{ url, type: sourceTypeFromUrl(url) }],
      created_at: new Date().toISOString(),
    });
    await addImport({
      url,
      status: "needs_extraction",
      source_type: sourceTypeFromUrl(url),
      recipe_id: draftRecipe.id,
      error: error.message,
    });
    response.status(202).json({ ok: true, recipe: draftRecipe, source: "file-draft" });
  }
});

app.post("/api/agent/chat", async (request, response) => {
  const message = request.body.message ?? "";
  const pantryItems = request.body.pantry_items ?? [];

  // Bypass RocketRide for chat: retrieve directly from the Neo4j graph and the
  // Spoonacular API in parallel, then let Butterbase route/answer over both
  // context sets. Each source degrades independently — if one fails, the other
  // still informs the answer.
  const [graphOutcome, spoonacularOutcome] = await Promise.allSettled([
    getGraphRecipeContext(pantryItems),
    getSpoonacularContext(message, pantryItems),
  ]);

  const graph =
    graphOutcome.status === "fulfilled" ? graphOutcome.value : { source: "neo4j", recipes: [] };
  const spoonacular =
    spoonacularOutcome.status === "fulfilled"
      ? spoonacularOutcome.value
      : { source: "spoonacular", recipes: [] };

  if (graphOutcome.status === "rejected") {
    console.warn("Graph retrieval failed:", graphOutcome.reason?.message);
  }
  if (spoonacularOutcome.status === "rejected") {
    console.warn("Spoonacular retrieval failed:", spoonacularOutcome.reason?.message);
  }

  const retrieved = {
    graph: { source: graph.source, count: graph.recipes.length },
    spoonacular: { count: spoonacular.recipes.length },
  };

  // Trim each source to a lean, model-friendly shape. A bloated context makes
  // gpt-5-nano over-reason (burning the token budget), so send only what the
  // model needs to route and answer.
  const compactGraph = graph.recipes.slice(0, 12).map((recipe) => ({
    name: recipe.name,
    matched: recipe.matchCount ?? (recipe.matched?.length ?? 0),
    total: recipe.total ?? (recipe.ingredients?.length ?? 0),
    ingredients: (recipe.ingredients ?? []).slice(0, 10),
    source: recipe.source ?? recipe.sources?.[0]?.url ?? null,
  }));
  const compactSpoonacular = spoonacular.recipes.map((recipe) => ({
    name: recipe.name,
    ingredients: (recipe.ingredients ?? []).slice(0, 10),
    source: recipe.source ?? null,
  }));

  if (!isButterbaseAiConfigured()) {
    response.json({
      reply: localAgentReply(message, pantryItems, await listRecipes()),
      source: "local-fallback",
      retrieved,
    });
    return;
  }

  try {
    const aiResult = await createButterbaseChatCompletion({
      messages: [
        {
          role: "system",
          content:
            "You are bepgraph, a recipe agent. You are given recipe candidates from TWO sources: " +
            "'graph_recipes' (the user's own saved Neo4j collection, each with matched/matchCount showing pantry overlap) " +
            "and 'spoonacular_recipes' (an external recipe API). " +
            "Answer the user's actual question: if they ask what recipes they have or to list/browse their collection, " +
            "summarize graph_recipes (these ARE their saved recipes regardless of pantry overlap) — never claim they have " +
            "none when graph_recipes is non-empty. If they ask for a recommendation, prefer graph recipes with the highest " +
            "matchCount; if no graph recipe overlaps the pantry well, say so plainly and offer spoonacular suggestions " +
            "instead of forcing a weak match. Do not invent recipes or pretend an unrelated recipe fits. " +
            "Be concise and practical: name the recipe, list which pantry ingredients match and which are missing, " +
            "include a source URL when available, and state which source (graph or spoonacular) you used.",
        },
        {
          role: "user",
          content: JSON.stringify({
            request: message,
            pantry_items: pantryItems,
            graph_recipes: compactGraph,
            spoonacular_recipes: compactSpoonacular,
          }),
        },
      ],
      // gpt-5-nano is a reasoning model: reasoning tokens count against this
      // budget. Low effort keeps reasoning small so the visible answer fits.
      maxTokens: 2000,
      temperature: 0.4,
      reasoningEffort: "low",
    });

    response.json({
      reply: aiResult.content,
      model: aiResult.model,
      source: "graph+spoonacular",
      retrieved,
    });
  } catch (error) {
    response.json({
      reply: localAgentReply(message, pantryItems, await listRecipes()),
      source: "local-fallback",
      warning: error.message,
      retrieved,
    });
  }
});

app.post("/api/graph/query", async (request, response, next) => {
  const pantryItems = request.body.params?.pantry_items ?? [];

  if (!isNeo4jConfigured()) {
    response.json({ rows: await queryRecipesByPantry(pantryItems), source: "file" });
    return;
  }

  const session = getDriver().session();

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (r:Recipe)-[:REQUIRES]->(i:Ingredient)
        WHERE i.name IN $pantry_items
        WITH r, count(DISTINCT i) AS matches
        MATCH (r)-[:REQUIRES]->(allIngredients:Ingredient)
        WITH r, matches, count(DISTINCT allIngredients) AS total
        WHERE matches >= total - 1 OR matches > 0
        RETURN r.name AS name, matches, total
        ORDER BY matches DESC
        LIMIT 10
        `,
        { pantry_items: pantryItems.map((item) => item.toLowerCase()) },
      ),
    );

    response.json({ rows: result.records.map((record) => toNative(record.toObject())) });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message });
});

// On Vercel the Express app is imported as a serverless function handler (see
// api/index.js) and must NOT bind a port. Only start a listener when this file
// is executed directly (local `npm run dev` / `npm run server`).
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun && !process.env.VERCEL) {
  const server = app.listen(port, () => {
    console.log(`bepgraph backend listening on http://localhost:${port}`);
  });

  process.on("SIGINT", async () => {
    await closeDriver();
    server.close(() => process.exit(0));
  });
}

export default app;
