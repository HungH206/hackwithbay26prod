const defaultApiUrl = "https://api.spoonacular.com";

function getConfig() {
  return {
    apiUrl: process.env.SPOONACULAR_API_URL ?? defaultApiUrl,
    apiKey: process.env.SPOONACULAR_API_KEY,
  };
}

function assertConfigured() {
  if (!getConfig().apiKey) {
    throw new Error("Missing SPOONACULAR_API_KEY");
  }
}

async function spoonacularFetch(pathname, params = {}) {
  assertConfigured();
  const { apiUrl, apiKey } = getConfig();
  const url = new URL(pathname, apiUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.message ?? data.status ?? `Spoonacular request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

export async function searchSpoonacularRecipes({ query, number = 10 }) {
  return spoonacularFetch("/recipes/complexSearch", {
    query,
    number,
    addRecipeInformation: true,
    addRecipeInstructions: true,
    fillIngredients: true,
  });
}

export async function getSpoonacularRecipe(recipeId) {
  return spoonacularFetch(`/recipes/${recipeId}/information`, {
    includeNutrition: false,
  });
}

function getSpoonacularAuthor(recipe) {
  return recipe.creditsText ?? recipe.sourceName ?? "Spoonacular";
}

function normalizeSpoonacularSteps(recipe) {
  const instructions = recipe.analyzedInstructions ?? [];
  const steps = instructions.flatMap((instruction) => instruction.steps ?? []);

  if (steps.length) {
    return steps.map((step, index) => ({
      order: index + 1,
      text: step.step,
    }));
  }

  if (recipe.instructions) {
    return [{ order: 1, text: recipe.instructions.replace(/<[^>]*>/g, " ").trim() }];
  }

  return [];
}

export function normalizeSpoonacularRecipe(recipe) {
  const ingredients = (recipe.extendedIngredients ?? []).map((ingredient) => ({
    name: ingredient.nameClean ?? ingredient.name,
    quantity: ingredient.amount ?? null,
    unit: ingredient.unit ?? null,
    original: ingredient.original ?? null,
    external_id: ingredient.id ? String(ingredient.id) : null,
  }));

  const sources = [
    recipe.sourceUrl
      ? {
          url: recipe.sourceUrl,
          type: "webpage",
          title: recipe.sourceName ?? "Original recipe source",
        }
      : null,
    recipe.spoonacularSourceUrl
      ? {
          url: recipe.spoonacularSourceUrl,
          type: "webpage",
          title: "Spoonacular recipe page",
        }
      : null,
  ].filter(Boolean);

  return {
    name: recipe.title,
    author: getSpoonacularAuthor(recipe),
    ingredients,
    steps: normalizeSpoonacularSteps(recipe),
    sources,
    provider: "spoonacular",
    external_id: String(recipe.id),
    image_url: recipe.image ?? null,
    provider_metadata: {
      readyInMinutes: recipe.readyInMinutes ?? null,
      servings: recipe.servings ?? null,
      sourceName: recipe.sourceName ?? null,
      spoonacularScore: recipe.spoonacularScore ?? null,
    },
    created_at: new Date().toISOString(),
  };
}
