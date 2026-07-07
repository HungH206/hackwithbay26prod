import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databasePath = path.resolve(__dirname, "../data/recipes.json");

async function readDatabase() {
  const raw = await readFile(databasePath, "utf8");
  return JSON.parse(raw);
}

async function writeDatabase(database) {
  const nextDatabase = {
    ...database,
    updated_at: new Date().toISOString(),
  };
  await writeFile(databasePath, `${JSON.stringify(nextDatabase, null, 2)}\n`);
  return nextDatabase;
}

function normalizeIngredient(ingredient) {
  if (typeof ingredient === "string") {
    return { name: ingredient.trim().toLowerCase() };
  }

  return {
    name: ingredient.name?.trim().toLowerCase(),
    quantity: ingredient.quantity ?? null,
    unit: ingredient.unit ?? null,
    original: ingredient.original ?? null,
    external_id: ingredient.external_id ?? null,
  };
}

function normalizeStep(step, index) {
  if (typeof step === "string") {
    return { order: index + 1, text: step.trim() };
  }

  return {
    order: step.order ?? index + 1,
    text: step.text?.trim(),
  };
}

function compactRecipe(recipe) {
  return {
    id: recipe.id,
    owner_user_id: recipe.owner_user_id,
    name: recipe.name,
    author: recipe.author,
    ingredients: recipe.ingredients.map((ingredient) => ingredient.name),
    steps: recipe.steps.map((step) => step.text),
    sources: recipe.sources ?? [],
    provider: recipe.provider ?? null,
    external_id: recipe.external_id ?? null,
    image_url: recipe.image_url ?? null,
    provider_metadata: recipe.provider_metadata ?? null,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
  };
}

export async function listRecipes() {
  const database = await readDatabase();
  return database.recipes.map(compactRecipe);
}

export async function addRecipe(payload) {
  const database = await readDatabase();
  const recipe = payload.recipe ?? payload;
  const ingredients = payload.ingredients ?? recipe.ingredients ?? [];
  const steps = payload.steps ?? recipe.steps ?? [];
  const now = new Date().toISOString();

  const nextRecipe = {
    id: recipe.id ?? randomUUID(),
    owner_user_id: recipe.owner_user_id ?? "user-demo",
    name: recipe.name,
    author: recipe.author,
    ingredients: ingredients.map(normalizeIngredient).filter((ingredient) => ingredient.name),
    steps: steps.map(normalizeStep).filter((step) => step.text),
    sources: payload.sources ?? recipe.sources ?? [],
    provider: recipe.provider ?? payload.provider ?? null,
    external_id: recipe.external_id ?? payload.external_id ?? null,
    image_url: recipe.image_url ?? payload.image_url ?? null,
    provider_metadata: recipe.provider_metadata ?? payload.provider_metadata ?? null,
    tags: recipe.tags ?? [],
    created_at: recipe.created_at ?? now,
    updated_at: now,
  };

  database.recipes.unshift(nextRecipe);
  await writeDatabase(database);
  return compactRecipe(nextRecipe);
}

export async function updateRecipe(recipeId, patch) {
  const database = await readDatabase();
  const recipe = database.recipes.find((item) => item.id === recipeId);
  if (!recipe) return null;

  if (patch.name !== undefined) recipe.name = patch.name;
  if (patch.author !== undefined) recipe.author = patch.author;
  if (patch.ingredients !== undefined) {
    recipe.ingredients = patch.ingredients.map(normalizeIngredient).filter((ingredient) => ingredient.name);
  }
  if (patch.steps !== undefined) {
    recipe.steps = patch.steps.map(normalizeStep).filter((step) => step.text);
  }
  if (patch.sources !== undefined) recipe.sources = patch.sources;
  if (patch.tags !== undefined) recipe.tags = patch.tags;
  if (patch.provider !== undefined) recipe.provider = patch.provider;
  if (patch.external_id !== undefined) recipe.external_id = patch.external_id;
  if (patch.image_url !== undefined) recipe.image_url = patch.image_url;
  if (patch.provider_metadata !== undefined) recipe.provider_metadata = patch.provider_metadata;

  recipe.updated_at = new Date().toISOString();
  await writeDatabase(database);
  return compactRecipe(recipe);
}

export async function addImport(importRecord) {
  const database = await readDatabase();
  database.imports.unshift({
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...importRecord,
  });
  await writeDatabase(database);
}

export async function queryRecipesByPantry(pantryItems) {
  const database = await readDatabase();
  const pantry = new Set(pantryItems.map((item) => item.toLowerCase()));

  return database.recipes
    .map((recipe) => {
      const ingredientNames = recipe.ingredients.map((ingredient) => ingredient.name.toLowerCase());
      const matches = ingredientNames.filter((ingredient) => pantry.has(ingredient)).length;
      return { name: recipe.name, matches, total: ingredientNames.length };
    })
    .filter((row) => row.matches >= row.total - 1 || row.matches > 0)
    .sort((a, b) => b.matches - a.matches);
}
