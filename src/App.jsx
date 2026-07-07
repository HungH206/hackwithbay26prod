import { useEffect, useMemo, useRef, useState } from "react";

const api = {
  health: "/api/health",
  recipes: "/api/recipes",
  recipeFromLink: "/api/recipes/from-link",
  chat: "/api/agent/chat",
  graphQuery: "/api/graph/query",
  spoonacularSearch: "/api/providers/spoonacular/search",
  spoonacularSave: (id) => `/api/providers/spoonacular/recipes/${id}/save`,
};

const demoRecipes = [
  {
    id: "demo-1",
    name: "Ginger Tofu Rice Bowl",
    author: "bepgraph Demo",
    ingredients: ["tofu", "rice", "ginger", "garlic", "spinach", "soy sauce"],
    steps: [
      "Cook rice.",
      "Sear tofu with ginger and garlic.",
      "Wilt spinach and finish with soy sauce.",
    ],
    sources: [{ url: "https://example.com/ginger-tofu-rice-bowl", type: "webpage" }],
    created_at: new Date().toISOString(),
  },
  {
    id: "demo-2",
    name: "Quick Tomato Lentil Soup",
    author: "bepgraph Demo",
    ingredients: ["lentils", "tomato", "onion", "garlic", "cumin"],
    steps: ["Soften onion and garlic.", "Simmer lentils with tomato and cumin."],
    sources: [{ url: "https://example.com/tomato-lentil-soup", type: "webpage" }],
    created_at: new Date().toISOString(),
  },
];

const cypherQuery = `MATCH (r:Recipe)-[:REQUIRES]->(i:Ingredient)
WHERE i.name IN $pantry_items
WITH r, count(i) AS matches, size((r)-[:REQUIRES]->()) AS total
WHERE matches >= total - 1
RETURN r.name, matches, total
ORDER BY matches DESC`;

const initialManualRecipe = {
  name: "Ginger Tofu Rice Bowl",
  author: "bepgraph Demo",
  ingredients: "tofu, rice, ginger, garlic, spinach, soy sauce",
  steps:
    "Cook rice. Sear tofu with ginger and garlic. Wilt spinach. Finish with soy sauce and serve over rice.",
  links: "https://example.com/ginger-tofu-rice-bowl",
};

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `recipe-${Date.now()}`;
}

function parseList(value) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSteps(value) {
  return value
    .split(/\n|\. /)
    .map((item) => item.replace(/\.$/, "").trim())
    .filter(Boolean);
}

function inferSourceType(url) {
  if (!url) return "webpage";
  if (/youtube|youtu\.be|vimeo|tiktok|instagram/i.test(url)) return "video";
  if (/\.pdf($|\?)/i.test(url)) return "document";
  return "webpage";
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

function ingredientLabel(ingredient) {
  if (typeof ingredient === "string") return ingredient;
  return ingredient.name ?? "";
}

function stepLabel(step) {
  if (typeof step === "string") return step;
  return step.text ?? "";
}

function normalizeClientRecipe(recipe) {
  return {
    ...recipe,
    id: recipe.id ?? createId(),
    name: recipe.name ?? recipe.title ?? "Untitled recipe",
    author: recipe.author ?? recipe.sourceName ?? "Unknown author",
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    steps: Array.isArray(recipe.steps) ? recipe.steps : [],
    sources: Array.isArray(recipe.sources) ? recipe.sources : [],
  };
}

function normalizeRecipe(form) {
  const link = form.links.trim();
  return {
    id: createId(),
    name: form.name.trim(),
    author: form.author.trim(),
    ingredients: parseList(form.ingredients),
    steps: parseSteps(form.steps),
    sources: link ? [{ url: link, type: inferSourceType(link) }] : [],
    created_at: new Date().toISOString(),
  };
}

function recipeToGraphPayload(recipe) {
  return {
    recipe: {
      name: recipe.name,
      author: recipe.author,
      created_at: recipe.created_at,
    },
    ingredients: recipe.ingredients.map((name) => ({ name })),
    steps: recipe.steps.map((text, index) => ({ order: index + 1, text })),
    sources: recipe.sources,
    relationships: {
      requires: recipe.ingredients.map((name) => ({ ingredient: name })),
      has_step: recipe.steps.map((_, index) => ({ order: index + 1 })),
      sourced_from: recipe.sources.map((source) => ({ url: source.url })),
    },
  };
}

function recipeToUpdatePayload(form) {
  return {
    name: form.name.trim(),
    author: form.author.trim(),
    ingredients: parseList(form.ingredients).map((name) => ({ name })),
    steps: form.steps
      .split("\n")
      .map((step) => step.trim())
      .filter(Boolean)
      .map((text, index) => ({ order: index + 1, text })),
    sources: parseList(form.links).map((url) => ({ url, type: inferSourceType(url) })),
  };
}

function localAgentReply(message, pantryValue, recipes) {
  const pantry = parseList(pantryValue.toLowerCase());
  const scored = recipes
    .map((recipe) => {
      const matches = recipe.ingredients.filter((ingredient) =>
        pantry.includes(ingredientLabel(ingredient).toLowerCase()),
      ).length;
      return { recipe, matches, total: recipe.ingredients.length };
    })
    .filter((item) => item.matches > 0)
    .sort((a, b) => b.matches - a.matches);

  if (/similar|like|related/i.test(message) && recipes.length > 1) {
    return `Similarity path: ${recipes[0].name} shares ingredient nodes with ${recipes
      .slice(1)
      .map((recipe) => recipe.name)
      .join(", ")}.`;
  }

  if (!scored.length) {
    return "I do not see a strong pantry match yet. Add more pantry ingredients or save another recipe to expand the graph.";
  }

  const best = scored[0];
  return `Best match: ${best.recipe.name}. It matches ${best.matches} of ${best.total} ingredient nodes from your pantry.`;
}

function runLocalGraphQuery(pantryValue, recipes) {
  const pantry = parseList(pantryValue.toLowerCase());
  return recipes
    .map((recipe) => {
      const matches = recipe.ingredients.filter((ingredient) =>
        pantry.includes(ingredientLabel(ingredient).toLowerCase()),
      ).length;
      return { name: recipe.name, matches, total: recipe.ingredients.length };
    })
    .filter((row) => row.matches >= row.total - 1 || row.matches > 0)
    .sort((a, b) => b.matches - a.matches);
}

function Sidebar({ activeTab, onTabChange, systemStatus }) {
  const tabs = [
    ["agent", "A", "Agent"],
    ["recreational", "R", "Recipe Recreational"],
    ["graph", "G", "Graph Data"],
    ["data", "D", "Spoonacular Data"],
  ];

  return (
    <aside className="sidebar" aria-label="bepgraph navigation">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          BG
        </div>
        <div>
          <h1>bepgraph</h1>
          <p>Knowledge graph meal agent</p>
        </div>
      </div>

      <nav className="nav-tabs" aria-label="Main sections">
        {tabs.map(([id, icon, label]) => (
          <button
            className={`nav-tab ${activeTab === id ? "is-active" : ""}`}
            type="button"
            key={id}
            onClick={() => onTabChange(id)}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      <div className="status-panel">
        <span className="status-dot" />
        <div>
          <strong>{systemStatus?.butterbaseAiModel ?? "openai/gpt-5-nano"}</strong>
          <p>
            Butterbase {systemStatus?.butterbaseConfigured ? "connected" : "not configured"} ·
            RocketRide {systemStatus?.rocketRideConfigured ? "configured" : "missing"}
          </p>
          <p>
            Neo4j {systemStatus?.neo4jConfigured ? "active" : "file database"} ·
            {systemStatus?.butterbaseAppScoped ? " app-scoped AI" : " app-less AI"}
          </p>
        </div>
      </div>
    </aside>
  );
}

function Hero() {
  return (
    <section className="hero-band" aria-label="bepgraph overview">
      <div className="hero-copy">
        <p className="eyebrow">Graph-aware cooking workspace</p>
        <h2>Ask for a meal, import recipes from links, and save your own graph-ready dishes.</h2>
      </div>
      <img
        src="https://images.unsplash.com/photo-1495521821757-a1efb6729352?auto=format&fit=crop&w=900&q=80"
        alt="Recipe notebook with ingredients on a kitchen table"
      />
    </section>
  );
}

function AgentPanel({
  messages,
  chatInput,
  setChatInput,
  pantry,
  setPantry,
  onChatSubmit,
  onSeedPantry,
  recipeCount,
  ingredientCount,
}) {
  return (
    <section className="tab-panel is-active" id="agent" aria-labelledby="agent-heading">
      <div className="section-header">
        <div>
          <p className="eyebrow">Meal agent</p>
          <h2 id="agent-heading">Chat With The Recipe Agent</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onSeedPantry}>
          Use sample pantry
        </button>
      </div>

      <div className="workspace-grid">
        <section className="tool-panel chat-panel" aria-label="Agent chat">
          <div className="messages" aria-live="polite">
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                {message.text}
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={onChatSubmit}>
            <label className="sr-only" htmlFor="chatInput">
              Ask the recipe agent
            </label>
            <input
              id="chatInput"
              name="message"
              type="text"
              autoComplete="off"
              placeholder="Ask: What can I cook with tofu, rice, spinach?"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              required
            />
            <button className="primary-button" type="submit">
              Send
            </button>
          </form>
        </section>

        <section className="tool-panel" aria-label="Pantry and recommendation context">
          <h3>Pantry Context</h3>
          <p className="panel-copy">
            The agent can pass these items to Neo4j traversal queries for match scoring.
          </p>
          <label htmlFor="pantryInput">Available ingredients</label>
          <textarea
            id="pantryInput"
            rows="8"
            value={pantry}
            onChange={(event) => setPantry(event.target.value)}
          />
          <div className="metric-row">
            <div>
              <span className="metric-value">{recipeCount}</span>
              <span className="metric-label">recipes</span>
            </div>
            <div>
              <span className="metric-value">{ingredientCount}</span>
              <span className="metric-label">ingredients</span>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function RecipeCard({ recipe, isSelected, onSelect }) {
  const source = recipe.sources?.[0];

  return (
    <article className={`recipe-card ${isSelected ? "is-selected" : ""}`}>
      <header>
        <div>
          <h4>{recipe.name}</h4>
          <p>by {recipe.author}</p>
        </div>
        {source ? (
          <a className="source-link" href={source.url} target="_blank" rel="noreferrer">
            {source.type} source
          </a>
        ) : (
          <span>No source attached</span>
        )}
      </header>
      <div className="pill-row">
        {recipe.ingredients.map((ingredient) => (
          <span className="pill" key={`${recipe.id}-${ingredientLabel(ingredient)}`}>
            {ingredientLabel(ingredient)}
          </span>
        ))}
      </div>
      <p>{recipe.steps.slice(0, 2).map(stepLabel).join(" ")}</p>
      <button className="secondary-button compact-button" type="button" onClick={() => onSelect(recipe)}>
        View recipe
      </button>
    </article>
  );
}

function RecipeModal({ recipe, onClose, onSave, isSaving }) {
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    name: "",
    author: "",
    ingredients: "",
    steps: "",
    links: "",
  });

  useEffect(() => {
    if (!recipe) return;
    setIsEditing(false);
    setForm({
      name: recipe.name,
      author: recipe.author,
      ingredients: recipe.ingredients.map(ingredientLabel).join(", "),
      steps: recipe.steps.map(stepLabel).join("\n"),
      links: recipe.sources?.map((source) => source.url).join("\n") ?? "",
    });
  }, [recipe]);

  if (!recipe) return null;

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  async function handleSave(event) {
    event.preventDefault();
    await onSave(recipe.id, recipeToUpdatePayload(form));
    setIsEditing(false);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="recipe-modal" role="dialog" aria-modal="true" aria-label={`${recipe.name} recipe`}>
        <div className="detail-header">
          <div>
            <p className="eyebrow">Cooking window</p>
            <h3>{recipe.name}</h3>
            <p>by {recipe.author}</p>
          </div>
          <div className="modal-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => setIsEditing(!isEditing)}>
              {isEditing ? "Cancel edit" : "Edit recipe"}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onClose}>
              Close when done
            </button>
          </div>
        </div>

        {isEditing ? (
          <form className="modal-edit-form" onSubmit={handleSave}>
            <label htmlFor="modalRecipeName">Recipe name</label>
            <input
              id="modalRecipeName"
              value={form.name}
              onChange={(event) => updateField("name", event.target.value)}
              required
            />

            <label htmlFor="modalRecipeAuthor">Author</label>
            <input
              id="modalRecipeAuthor"
              value={form.author}
              onChange={(event) => updateField("author", event.target.value)}
              required
            />

            <label htmlFor="modalRecipeIngredients">Ingredients</label>
            <textarea
              id="modalRecipeIngredients"
              rows="5"
              value={form.ingredients}
              onChange={(event) => updateField("ingredients", event.target.value)}
              required
            />

            <label htmlFor="modalRecipeSteps">Steps</label>
            <textarea
              id="modalRecipeSteps"
              rows="7"
              value={form.steps}
              onChange={(event) => updateField("steps", event.target.value)}
              required
            />

            <label htmlFor="modalRecipeLinks">Reference links</label>
            <textarea
              id="modalRecipeLinks"
              rows="3"
              value={form.links}
              onChange={(event) => updateField("links", event.target.value)}
            />

            <button className="primary-button full-width" type="submit" disabled={isSaving}>
              {isSaving ? "Saving..." : "Save changes to database"}
            </button>
          </form>
        ) : (
          <>
            <div className="detail-section">
              <h4>Ingredients</h4>
              <ul className="ingredient-list">
                {recipe.ingredients.map((ingredient) => (
                  <li key={`${recipe.id}-detail-${ingredientLabel(ingredient)}`}>{ingredientLabel(ingredient)}</li>
                ))}
              </ul>
            </div>

            <div className="detail-section">
              <h4>Steps</h4>
              <ol className="step-list">
                {recipe.steps.map((step, index) => (
                  <li key={`${recipe.id}-step-${index}`}>{stepLabel(step)}</li>
                ))}
              </ol>
            </div>

            <div className="detail-section">
              <h4>Reference Links</h4>
              {recipe.sources?.length ? (
                <div className="source-list">
                  {recipe.sources.map((source) => (
                    <a className="source-link" href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                      {source.title ?? source.type ?? "Original source"}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="panel-copy">No source links attached.</p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function RecreationalPanel({
  formMode,
  setFormMode,
  manualRecipe,
  setManualRecipe,
  recipeUrl,
  setRecipeUrl,
  onRecipeSubmit,
  onLoadRecipes,
  search,
  setSearch,
  filteredRecipes,
  selectedRecipe,
  onSelectRecipe,
  onCloseRecipe,
  onUpdateRecipe,
  isSavingRecipe,
}) {
  const updateManualField = (field, value) => {
    setManualRecipe((current) => ({ ...current, [field]: value }));
  };

  return (
    <section className="tab-panel is-active" id="recreational" aria-labelledby="recreational-heading">
      <div className="section-header">
        <div>
          <p className="eyebrow">Personal library</p>
          <h2 id="recreational-heading">Recipe Recreational</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onLoadRecipes}>
          Fetch saved recipes
        </button>
      </div>

      <div className="workspace-grid">
        <section className="tool-panel" aria-label="Save recipe">
          <div className="form-tabs" role="tablist" aria-label="Recipe input method">
            <button
              className={`form-tab ${formMode === "manual" ? "is-active" : ""}`}
              type="button"
              onClick={() => setFormMode("manual")}
            >
              Manual
            </button>
            <button
              className={`form-tab ${formMode === "link" ? "is-active" : ""}`}
              type="button"
              onClick={() => setFormMode("link")}
            >
              From link
            </button>
          </div>

          <form className="recipe-form" onSubmit={onRecipeSubmit}>
            {formMode === "manual" ? (
              <div className="manual-fields">
                <label htmlFor="recipeName">Recipe name</label>
                <input
                  id="recipeName"
                  name="name"
                  type="text"
                  value={manualRecipe.name}
                  onChange={(event) => updateManualField("name", event.target.value)}
                  required
                />

                <label htmlFor="recipeAuthor">Author</label>
                <input
                  id="recipeAuthor"
                  name="author"
                  type="text"
                  value={manualRecipe.author}
                  onChange={(event) => updateManualField("author", event.target.value)}
                  required
                />

                <label htmlFor="recipeIngredients">Ingredients</label>
                <textarea
                  id="recipeIngredients"
                  name="ingredients"
                  rows="5"
                  value={manualRecipe.ingredients}
                  onChange={(event) => updateManualField("ingredients", event.target.value)}
                  required
                />

                <label htmlFor="recipeSteps">Recipe steps</label>
                <textarea
                  id="recipeSteps"
                  name="steps"
                  rows="5"
                  value={manualRecipe.steps}
                  onChange={(event) => updateManualField("steps", event.target.value)}
                  required
                />

                <label htmlFor="recipeLinks">Recipe links</label>
                <input
                  id="recipeLinks"
                  name="links"
                  type="url"
                  value={manualRecipe.links}
                  onChange={(event) => updateManualField("links", event.target.value)}
                />
              </div>
            ) : (
              <div className="link-fields">
                <label htmlFor="recipeUrl">Recipe URL, video, or document</label>
                <input
                  id="recipeUrl"
                  name="url"
                  type="url"
                  placeholder="https://example.com/recipe"
                  value={recipeUrl}
                  onChange={(event) => setRecipeUrl(event.target.value)}
                  required
                />
                <p className="panel-copy">
                  Submitting a link calls the MCP extraction path: fetch_document, extract_recipe,
                  then ingest_recipe.
                </p>
              </div>
            )}

            <button className="primary-button full-width" type="submit">
              Save to graph shape
            </button>
          </form>
        </section>

        <section className="tool-panel library-panel" aria-label="Saved recipes">
          <div className="library-toolbar">
            <h3>Saved Recipes</h3>
            <input
              type="search"
              placeholder="Filter by ingredient or recipe"
              aria-label="Filter recipes"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="recipe-list">
            {filteredRecipes.length ? (
              filteredRecipes.map((recipe) => (
                <RecipeCard
                  recipe={recipe}
                  isSelected={selectedRecipe?.id === recipe.id}
                  onSelect={onSelectRecipe}
                  key={recipe.id}
                />
              ))
            ) : (
              <div className="query-output">No recipes match that filter.</div>
            )}
          </div>
        </section>
      </div>
      <RecipeModal
        recipe={selectedRecipe}
        onClose={onCloseRecipe}
        onSave={onUpdateRecipe}
        isSaving={isSavingRecipe}
      />
    </section>
  );
}

function GraphPanel({ pantry, recipes, showToast }) {
  const [queryOutput, setQueryOutput] = useState("Run the sample query to preview agent-ready results.");

  async function handleRunGraphQuery() {
    try {
      const data = await postJson(api.graphQuery, {
        query: cypherQuery,
        params: { pantry_items: parseList(pantry) },
      });
      setQueryOutput(JSON.stringify(data.rows ?? data, null, 2));
    } catch {
      setQueryOutput(JSON.stringify(runLocalGraphQuery(pantry, recipes), null, 2));
      showToast("Backend unavailable, previewed query from local recipes.");
    }
  }

  return (
    <section className="tab-panel is-active" id="graph" aria-labelledby="graph-heading">
      <div className="section-header">
        <div>
          <p className="eyebrow">Neo4j workspace</p>
          <h2 id="graph-heading">Dedicated bepgraph Data</h2>
        </div>
        <button className="secondary-button" type="button" onClick={handleRunGraphQuery}>
          Run sample query
        </button>
      </div>

      <div className="graph-layout">
        <section className="tool-panel" aria-label="Graph model">
          <h3>Data Structure</h3>
          <div className="graph-model">
            <div className="node recipe-node">Recipe</div>
            <div className="edge">REQUIRES</div>
            <div className="node ingredient-node">Ingredient</div>
            <div className="edge">SOURCED_FROM</div>
            <div className="node source-node">Source</div>
            <div className="edge">HAS_STEP</div>
            <div className="node step-node">Step</div>
          </div>
        </section>

        <section className="tool-panel" aria-label="Graph query">
          <h3>Graph Query Preview</h3>
          <pre>
            <code>{cypherQuery}</code>
          </pre>
          <div className="query-output">{queryOutput}</div>
        </section>
      </div>
    </section>
  );
}

function SpoonacularDataPanel({
  query,
  setQuery,
  results,
  selectedProviderRecipe,
  isSearching,
  isSavingProviderRecipe,
  onSearch,
  onSaveRecipe,
  onSelectRecipe,
  onCloseRecipe,
}) {
  return (
    <section className="tab-panel is-active" id="data" aria-labelledby="data-heading">
      <div className="section-header">
        <div>
          <p className="eyebrow">External data</p>
          <h2 id="data-heading">Spoonacular Recipe Data</h2>
        </div>
      </div>

      <div className="data-layout">
        <section className="tool-panel" aria-label="Spoonacular search">
          <h3>Search Available Recipes</h3>
          <p className="panel-copy">
            Search Spoonacular through the backend, inspect provider data, then save a recipe into the unified bepgraph database.
          </p>
          <form className="provider-search" onSubmit={onSearch}>
            <label htmlFor="spoonacularQuery">Food or recipe query</label>
            <div className="provider-search-row">
              <input
                id="spoonacularQuery"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="pizza, pasta, tofu, soup"
                required
              />
              <button className="primary-button" type="submit" disabled={isSearching}>
                {isSearching ? "Searching..." : "Search"}
              </button>
            </div>
          </form>
        </section>

        <section className="tool-panel provider-results-panel" aria-label="Spoonacular results">
          <div className="library-toolbar">
            <h3>Available Recipes</h3>
            <span className="metric-label">{results.length} results · scroll to browse</span>
          </div>

          <div className="provider-results">
            {results.length ? (
              results.map((recipe) => (
                <article
                  className={`provider-card ${selectedProviderRecipe?.id === recipe.id ? "is-selected" : ""}`}
                  key={recipe.id}
                  onClick={() => onSelectRecipe(recipe)}
                >
                  {recipe.image ? <img src={recipe.image} alt={recipe.title} /> : null}
                  <div className="provider-card-body">
                    <header>
                      <div>
                        <h4>{recipe.title}</h4>
                        <p>
                          {recipe.sourceName ?? "Spoonacular"}
                          {recipe.readyInMinutes ? ` · ${recipe.readyInMinutes} min` : ""}
                          {recipe.servings ? ` · ${recipe.servings} servings` : ""}
                        </p>
                      </div>
                      <span className="pill">ID {recipe.id}</span>
                    </header>

                    {recipe.summary ? (
                      <p
                        className="provider-summary"
                        dangerouslySetInnerHTML={{ __html: recipe.summary }}
                      />
                    ) : (
                      <p className="panel-copy">No summary returned for this recipe.</p>
                    )}

                    <div className="provider-card-actions">
                      {recipe.sourceUrl ? (
                        <a
                          className="source-link"
                          href={recipe.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                        >
                          Original source
                        </a>
                      ) : null}
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectRecipe(recipe);
                        }}
                      >
                        Preview
                      </button>
                      <button
                        className="primary-button compact-button"
                        type="button"
                        disabled={isSavingProviderRecipe === recipe.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSaveRecipe(recipe.id);
                        }}
                      >
                        {isSavingProviderRecipe === recipe.id ? "Saving..." : "Save to database"}
                      </button>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="query-output">
                Search Spoonacular to see recipes you can save into bepgraph.
              </div>
            )}
          </div>
        </section>
      </div>
      <SpoonacularPreviewModal
        recipe={selectedProviderRecipe}
        isSaving={isSavingProviderRecipe === selectedProviderRecipe?.id}
        onClose={onCloseRecipe}
        onSave={onSaveRecipe}
      />
    </section>
  );
}

function SpoonacularPreviewModal({ recipe, isSaving, onClose, onSave }) {
  if (!recipe) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="recipe-modal provider-modal" role="dialog" aria-modal="true" aria-label={`${recipe.title} preview`}>
        <button className="icon-close-button" type="button" aria-label="Close preview" onClick={onClose}>
          X
        </button>

        {recipe.image ? <img className="provider-modal-image" src={recipe.image} alt={recipe.title} /> : null}

        <div className="detail-header">
          <div>
            <p className="eyebrow">Spoonacular preview</p>
            <h3>{recipe.title}</h3>
            <p>
              {recipe.sourceName ?? "Spoonacular"}
              {recipe.readyInMinutes ? ` · ${recipe.readyInMinutes} min` : ""}
              {recipe.servings ? ` · ${recipe.servings} servings` : ""}
            </p>
          </div>
        </div>

        {recipe.summary ? (
          <div className="detail-section">
            <h4>Summary</h4>
            <p className="provider-modal-summary" dangerouslySetInnerHTML={{ __html: recipe.summary }} />
          </div>
        ) : null}

        <div className="detail-section">
          <h4>Provider Data</h4>
          <dl className="provider-data-list">
            <div>
              <dt>Provider</dt>
              <dd>Spoonacular</dd>
            </div>
            <div>
              <dt>External ID</dt>
              <dd>{recipe.id}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{recipe.sourceName ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Ready in</dt>
              <dd>{recipe.readyInMinutes ? `${recipe.readyInMinutes} minutes` : "Unknown"}</dd>
            </div>
          </dl>
        </div>

        <div className="provider-card-actions">
          {recipe.sourceUrl ? (
            <a className="source-link" href={recipe.sourceUrl} target="_blank" rel="noreferrer">
              Original source
            </a>
          ) : null}
          <button className="primary-button" type="button" disabled={isSaving} onClick={() => onSave(recipe.id)}>
            {isSaving ? "Saving..." : "Save to database"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("agent");
  const [recipes, setRecipes] = useState(demoRecipes);
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "agent",
      text:
        "Tell me what ingredients you have, ask for a special meal, or save recipes in the Recipe Recreational tab.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [pantry, setPantry] = useState("rice, garlic, tofu, spinach, soy sauce");
  const [formMode, setFormMode] = useState("manual");
  const [manualRecipe, setManualRecipe] = useState(initialManualRecipe);
  const [recipeUrl, setRecipeUrl] = useState("");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState(null);
  const [isRecipeModalOpen, setIsRecipeModalOpen] = useState(false);
  const [isSavingRecipe, setIsSavingRecipe] = useState(false);
  const [spoonacularQuery, setSpoonacularQuery] = useState("pizza");
  const [spoonacularResults, setSpoonacularResults] = useState([]);
  const [selectedProviderRecipe, setSelectedProviderRecipe] = useState(null);
  const [isSearchingSpoonacular, setIsSearchingSpoonacular] = useState(false);
  const [isSavingProviderRecipe, setIsSavingProviderRecipe] = useState(null);
  const [systemStatus, setSystemStatus] = useState(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    let isMounted = true;
    getJson(api.health)
      .then((status) => {
        if (isMounted) setSystemStatus(status);
      })
      .catch(() => {
        if (isMounted) {
          setSystemStatus({
            butterbaseAiModel: "openai/gpt-5-nano",
            butterbaseConfigured: false,
            rocketRideConfigured: false,
            neo4jConfigured: false,
            butterbaseAppScoped: false,
          });
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const ingredientCount = useMemo(
    () => new Set(recipes.flatMap((recipe) => normalizeClientRecipe(recipe).ingredients)).size,
    [recipes],
  );

  const filteredRecipes = useMemo(() => {
    const term = search.trim().toLowerCase();
    return recipes.map(normalizeClientRecipe).filter((recipe) => {
      const haystack = [
        recipe.name,
        recipe.author,
        ...recipe.ingredients.map(ingredientLabel),
      ]
        .join(" ")
        .toLowerCase();
      return !term || haystack.includes(term);
    });
  }, [recipes, search]);

  const selectedRecipe = useMemo(
    () => {
      if (!isRecipeModalOpen || !selectedRecipeId) return null;
      return recipes.find((recipe) => recipe.id === selectedRecipeId) ?? null;
    },
    [isRecipeModalOpen, recipes, selectedRecipeId],
  );

  function showToast(message) {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }

  async function handleChatSubmit(event) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) return;

    setMessages((current) => [...current, { id: createId(), role: "user", text: message }]);
    setChatInput("");

    try {
      const data = await postJson(api.chat, {
        message,
        pantry_items: parseList(pantry),
      });
      setMessages((current) => [
        ...current,
        { id: createId(), role: "agent", text: data.reply ?? localAgentReply(message, pantry, recipes) },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        { id: createId(), role: "agent", text: localAgentReply(message, pantry, recipes) },
      ]);
    }
  }

  async function handleRecipeSubmit(event) {
    event.preventDefault();

    if (formMode === "link") {
      const url = recipeUrl.trim();
      try {
        const data = await postJson(api.recipeFromLink, { url });
        setRecipes((current) => [data.recipe, ...current]);
        showToast("Recipe extracted from link and saved.");
      } catch {
        const fallback = {
          id: createId(),
          name: "Imported Recipe Draft",
          author: "MCP extraction pending",
          ingredients: ["ingredient nodes pending"],
          steps: [
            "Connect /api/recipes/from-link to fetch_document, extract_recipe, and ingest_recipe.",
          ],
          sources: [{ url, type: inferSourceType(url) }],
          created_at: new Date().toISOString(),
        };
        setRecipes((current) => [fallback, ...current]);
        showToast("Backend unavailable, saved link as a draft.");
      }
      return;
    }

    const recipe = normalizeRecipe(manualRecipe);
    try {
      await postJson(api.recipes, recipeToGraphPayload(recipe));
      showToast("Recipe saved to Neo4j graph API.");
    } catch {
      showToast("Backend unavailable, saved in this browser session.");
    }
    setRecipes((current) => [recipe, ...current]);
  }

  async function handleLoadRecipes() {
    try {
      const data = await getJson(api.recipes);
      setRecipes((data.recipes ?? recipes).map(normalizeClientRecipe));
      showToast("Fetched saved recipes.");
    } catch {
      showToast("Backend unavailable, showing local demo recipes.");
    }
  }

  async function handleUpdateRecipe(recipeId, payload) {
    setIsSavingRecipe(true);
    try {
      const data = await patchJson(`${api.recipes}/${recipeId}`, payload);
      const updatedRecipe = data.recipe ?? { id: recipeId, ...payload };
      setRecipes((current) =>
        current.map((recipe) => (recipe.id === recipeId ? { ...recipe, ...updatedRecipe } : recipe)),
      );
      setSelectedRecipeId(recipeId);
      showToast("Recipe updated in the database.");
    } catch {
      setRecipes((current) =>
        current.map((recipe) =>
          recipe.id === recipeId
            ? {
                ...recipe,
                name: payload.name,
                author: payload.author,
                ingredients: payload.ingredients.map((ingredient) => ingredient.name),
                steps: payload.steps.map((step) => step.text),
                sources: payload.sources,
              }
            : recipe,
        ),
      );
      showToast("Backend unavailable, updated in this browser session.");
    } finally {
      setIsSavingRecipe(false);
    }
  }

  async function handleSpoonacularSearch(event) {
    event.preventDefault();
    const query = spoonacularQuery.trim();
    if (!query) return;

    setIsSearchingSpoonacular(true);
    try {
      const params = new URLSearchParams({ query, number: "10" });
      const data = await getJson(`${api.spoonacularSearch}?${params.toString()}`);
      setSpoonacularResults(data.results ?? []);
      setSelectedProviderRecipe(null);
      showToast("Fetched Spoonacular recipe data.");
    } catch {
      showToast("Could not fetch Spoonacular data. Check the backend and API key.");
    } finally {
      setIsSearchingSpoonacular(false);
    }
  }

  async function handleSaveSpoonacularRecipe(recipeId) {
    setIsSavingProviderRecipe(recipeId);
    try {
      const data = await postJson(api.spoonacularSave(recipeId), {});
      if (data.recipe) {
        setRecipes((current) => [normalizeClientRecipe(data.recipe), ...current]);
      }
      setSelectedProviderRecipe(null);
      showToast("Saved Spoonacular recipe to the unified database.");
    } catch {
      showToast("Could not save Spoonacular recipe. Check the backend and API key.");
    } finally {
      setIsSavingProviderRecipe(null);
    }
  }

  return (
    <>
      <div className="app-shell">
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} systemStatus={systemStatus} />
        <main>
          <Hero />
          {activeTab === "agent" && (
            <AgentPanel
              messages={messages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              pantry={pantry}
              setPantry={setPantry}
              onChatSubmit={handleChatSubmit}
              onSeedPantry={() => {
                setPantry("rice, garlic, tofu, spinach, soy sauce, ginger");
                showToast("Sample pantry loaded.");
              }}
              recipeCount={recipes.length}
              ingredientCount={ingredientCount}
            />
          )}
          {activeTab === "recreational" && (
            <RecreationalPanel
              formMode={formMode}
              setFormMode={setFormMode}
              manualRecipe={manualRecipe}
              setManualRecipe={setManualRecipe}
              recipeUrl={recipeUrl}
              setRecipeUrl={setRecipeUrl}
              onRecipeSubmit={handleRecipeSubmit}
              onLoadRecipes={handleLoadRecipes}
              search={search}
              setSearch={setSearch}
              filteredRecipes={filteredRecipes}
              selectedRecipe={selectedRecipe}
              onSelectRecipe={(recipe) => {
                setSelectedRecipeId(recipe.id);
                setIsRecipeModalOpen(true);
              }}
              onCloseRecipe={() => {
                setIsRecipeModalOpen(false);
                setSelectedRecipeId(null);
              }}
              onUpdateRecipe={handleUpdateRecipe}
              isSavingRecipe={isSavingRecipe}
            />
          )}
          {activeTab === "graph" && (
            <GraphPanel pantry={pantry} recipes={recipes} showToast={showToast} />
          )}
          {activeTab === "data" && (
            <SpoonacularDataPanel
              query={spoonacularQuery}
              setQuery={setSpoonacularQuery}
              results={spoonacularResults}
              selectedProviderRecipe={selectedProviderRecipe}
              isSearching={isSearchingSpoonacular}
              isSavingProviderRecipe={isSavingProviderRecipe}
              onSearch={handleSpoonacularSearch}
              onSaveRecipe={handleSaveSpoonacularRecipe}
              onSelectRecipe={setSelectedProviderRecipe}
              onCloseRecipe={() => setSelectedProviderRecipe(null)}
            />
          )}
        </main>
      </div>

      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </>
  );
}
