import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditorText,
  createServerIndex,
  expandServerMentions,
  filterServerCompletions,
  parseCommandInput,
  renderServerContext,
  resolveServerReference,
} from "./context.ts";

test("creates stable aliases and resolves server names", () => {
  const index = createServerIndex(["github", "a:b", "a_3a_b"]);

  const aliases = [...index.aliasByServer.values()];
  assert.equal(new Set(aliases).size, 3);
  assert.ok(aliases.includes("a_3a_b"));
  assert.ok(aliases.includes("a_3a_b-2"));
  for (const [serverName, alias] of index.aliasByServer) {
    assert.equal(resolveServerReference(index, alias), serverName);
  }
  assert.equal(resolveServerReference(index, "github"), "github");
});

test("filters slash completions by fuzzy server text", () => {
  const items = [
    { value: "mcp:github", label: "/mcp:github", description: "github (connected, 4 tools)" },
    { value: "mcp:gitlab", label: "/mcp:gitlab", description: "gitlab (cached)" },
    { value: "mcp:select", label: "/mcp:select", description: "Choose an MCP server" },
  ];

  assert.deepEqual(
    filterServerCompletions(items, "gth").map((item) => item.value),
    ["mcp:github"],
  );
  assert.deepEqual(
    filterServerCompletions(items, "sel").map((item) => item.value),
    ["mcp:select"],
  );
});

test("expands only known #server mentions", () => {
  const index = createServerIndex(["github"]);
  const result = expandServerMentions("Use #github for this; keep #unknown unchanged.", index, (server) => `<ctx ${server}>`);

  assert.equal(result.changed, true);
  assert.deepEqual(result.servers, ["github"]);
  assert.equal(result.text, "Use <ctx github> for this; keep #unknown unchanged.");
});

test("leaves the existing @ syntax untouched", () => {
  const index = createServerIndex(["github"]);
  const result = expandServerMentions("Keep @github available for Pi's file completion.", index, () => "<unexpected>");

  assert.equal(result.changed, false);
  assert.equal(result.text, "Keep @github available for Pi's file completion.");
});

test("renders bounded escaped metadata without schemas by default", () => {
  const context = renderServerContext(
    "github",
    {
      instructions: "Use <safe> metadata only.",
      tools: [{ name: "search_code", description: "Search <repositories>" }],
      resources: [{ name: "docs", uri: "file:///docs" }],
      prompts: [{ name: "review", description: "Review a change" }],
    },
    { name: "github", status: "cached", toolCount: 1, disabled: false },
  );

  assert.match(context, /<mcp-context server="github" status="cached">/);
  assert.match(context, /&lt;safe&gt;/);
  assert.match(context, /search_code/);
  assert.doesNotMatch(context, /inputSchema/);
});

test("includes a schema only when explicitly requested", () => {
  const context = renderServerContext(
    "github",
    { tools: [{ name: "search_code", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
    undefined,
    { includeSchemas: true },
  );

  assert.match(context, /schema:/);
  assert.match(context, /properties/);
});

test("parses schema flag and preserves the prompt", () => {
  assert.deepEqual(parseCommandInput("--schemas find open issues"), {
    includeSchemas: true,
    prompt: "find open issues",
  });
  assert.equal(buildEditorText("<ctx/>", "find open issues"), "<ctx/>\n\nfind open issues");
});
