import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditorText,
  createNativeMcpSnapshot,
  createServerIndex,
  expandServerMentions,
  filterServerCompletions,
  parseCommandInput,
  parseMcpServersSection,
  renderServerContext,
  renderServerUse,
  renderServerUseWithTools,
  resolveServerReference,
} from "./context.ts";

const mcpTool = (
  namespace: string,
  name: string,
  exposure: "codemode" | "deferred" | "direct" | "hidden",
  description = `${name} description`,
  parameters?: unknown,
) => ({
  name: `${namespace}__${name}`,
  description,
  exposure,
  parameters,
  namespace: { name: namespace, description: `${namespace} namespace`, instructions: `Use ${namespace} carefully.` },
});

test("creates stable aliases and resolves hyphen/underscore server references", () => {
  const index = createServerIndex(["github", "dev_radius", "dev-radius"]);

  assert.equal(new Set(index.aliasByServer.values()).size, 3);
  assert.equal(resolveServerReference(index, "github"), "github");
  assert.equal(resolveServerReference(index, "dev-radius"), "dev-radius");
  assert.equal(resolveServerReference(index, "mcp__dev_radius"), "dev_radius");
});

test("filters slash completions by fuzzy server text", () => {
  const items = [
    { value: "mcp:github", label: "/mcp:github", description: "mcp__github (4 tools, deferred)" },
    { value: "mcp:gitlab", label: "/mcp:gitlab", description: "mcp__gitlab (no registered tools)" },
    { value: "mcp:select", label: "/mcp:select", description: "Choose a Pi-native MCP namespace" },
  ];

  assert.deepEqual(filterServerCompletions(items, "gth").map((item) => item.value), ["mcp:github"]);
  assert.deepEqual(filterServerCompletions(items, "sel").map((item) => item.value), ["mcp:select"]);
});

test("parses Pi's mcp_servers section without interpreting status", () => {
  const hints = parseMcpServersSection(
    "- mcp__github (deferred): GitHub search\n- mcp__secure (codemode): Private tools\n- mcp__offline (tool_search)",
  );

  assert.deepEqual(
    hints.map((hint) => [hint.name, hint.namespace.name, hint.exposure, hint.namespace.description]),
    [
      ["github", "mcp__github", "deferred", "GitHub search"],
      ["secure", "mcp__secure", "codemode", "Private tools"],
      ["offline", "mcp__offline", "deferred", undefined],
    ],
  );
});

test("builds a snapshot from configured namespaces and registered tools", () => {
  const snapshot = createNativeMcpSnapshot(
    [mcpTool("mcp__github", "search_code", "deferred")],
    "- mcp__github (deferred): GitHub search\n- mcp__offline (deferred): Not connected yet",
  );

  assert.deepEqual(snapshot.servers.map((server) => server.name), ["github", "offline"]);
  assert.equal(snapshot.servers[0]?.tools[0]?.name, "mcp__github__search_code");
  assert.equal(snapshot.servers[0]?.exposure, "deferred");
  assert.equal(snapshot.servers[0]?.namespace.description, "GitHub search");
  assert.equal(snapshot.servers[1]?.tools.length, 0);
});

test("keeps tools with the same short name distinct across namespaces", () => {
  const snapshot = createNativeMcpSnapshot([
    mcpTool("mcp__github", "search", "deferred"),
    mcpTool("mcp__gitlab", "search", "direct"),
  ]);

  assert.deepEqual(snapshot.servers.map((server) => server.name), ["github", "gitlab"]);
  assert.equal(snapshot.servers[0]?.tools[0]?.name, "mcp__github__search");
  assert.equal(snapshot.servers[1]?.tools[0]?.name, "mcp__gitlab__search");
  assert.match(renderServerContext(snapshot.servers[0]!), /tools\.mcp__github__search/);
  assert.match(renderServerContext(snapshot.servers[1]!), /tools\.mcp__gitlab__search/);
});

test("retains direct/deferred exposure information and reports mixed servers", () => {
  const snapshot = createNativeMcpSnapshot([
    mcpTool("mcp__mixed", "read", "direct"),
    mcpTool("mcp__mixed", "search", "deferred"),
  ]);

  assert.equal(snapshot.servers[0]?.exposure, "mixed");
  assert.match(renderServerContext(snapshot.servers[0]!), /\[direct\]/);
  assert.match(renderServerContext(snapshot.servers[0]!), /\[deferred\]/);
});

test("renders a short Pi-native hint by default", () => {
  const snapshot = createNativeMcpSnapshot([mcpTool("mcp__github", "search_code", "deferred")]);
  const hint = renderServerUse(snapshot.servers[0]!);

  assert.match(hint, /namespace="mcp__github"/);
  assert.match(hint, /searchTools/);
  assert.match(hint, /describeNamespace/);
  assert.match(hint, /tools\.mcp__github__search_code/);
  assert.doesNotMatch(hint, /mcp\(\{/);
  assert.doesNotMatch(hint, /<tools>/);
});

test("renders a no-connection namespace without claiming status", () => {
  const snapshot = createNativeMcpSnapshot([], "- mcp__offline (deferred): Offline server");
  const context = renderServerContext(snapshot.servers[0]!);

  assert.match(context, /No currently registered tool metadata/);
  assert.match(context, /builtin:mcp \/mcp/);
  assert.doesNotMatch(context, /status=/);
  assert.doesNotMatch(context, /cached|connected|authenticated|disabled/);
});

test("renders an authentication-failure hint without claiming success", () => {
  const snapshot = createNativeMcpSnapshot([], "- mcp__secure (deferred): authentication required");
  const context = renderServerContext(snapshot.servers[0]!);

  assert.match(context, /authentication required/);
  assert.match(context, /connection or authentication diagnostics/);
  assert.doesNotMatch(context, /authentication succeeded|authenticated|disabled/);
});

test("renders qualified tool names without schemas in short tool mode", () => {
  const snapshot = createNativeMcpSnapshot([
    mcpTool("mcp__github", "search_code", "deferred"),
    mcpTool("mcp__github", "get_file_contents", "deferred"),
  ]);
  const hint = renderServerUseWithTools(snapshot.servers[0]!);

  assert.match(hint, /mcp__github__search_code/);
  assert.match(hint, /mcp__github__get_file_contents/);
  assert.doesNotMatch(hint, /schema/);
});

test("full context includes schemas only when explicitly requested", () => {
  const snapshot = createNativeMcpSnapshot([
    mcpTool("mcp__github", "search_code", "deferred", "Search code", {
      type: "object",
      properties: { query: { type: "string" } },
    }),
  ]);

  const short = renderServerContext(snapshot.servers[0]!);
  const full = renderServerContext(snapshot.servers[0]!, { includeSchemas: true });
  assert.doesNotMatch(short, /schema:/);
  assert.match(full, /schema:/);
  assert.match(full, /query/);
});

test("expands only known #server mentions", () => {
  const index = createServerIndex(["github"]);
  const result = expandServerMentions(
    "Use #github for this; keep #unknown unchanged.",
    index,
    (server, options) => `<ctx ${server} full=${!!options.full}>`,
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.servers, ["github"]);
  assert.equal(result.text, "Use <ctx github full=false> for this; keep #unknown unchanged.");
});

test("does not absorb sentence punctuation into a server mention", () => {
  const index = createServerIndex(["github"]);
  const result = expandServerMentions("Use #github.", index, (server) => `<ctx ${server}>`);

  assert.equal(result.text, "Use <ctx github>.");
});

test("expands full and tool-list mention modifiers", () => {
  const index = createServerIndex(["github"]);
  const full = expandServerMentions("Use #github -f for this.", index, (server, options) =>
    `<ctx ${server} full=${!!options.full} schemas=${!!options.includeSchemas} tools=${!!options.listTools}>`,
  );
  const schemas = expandServerMentions("Use #github --schemas for this.", index, (server, options) =>
    `<ctx ${server} full=${!!options.full} schemas=${!!options.includeSchemas} tools=${!!options.listTools}>`,
  );
  const tools = expandServerMentions("Use #github --tools for this.", index, (server, options) =>
    `<ctx ${server} full=${!!options.full} schemas=${!!options.includeSchemas} tools=${!!options.listTools}>`,
  );

  assert.equal(full.text, "Use <ctx github full=true schemas=false tools=false> for this.");
  assert.equal(schemas.text, "Use <ctx github full=true schemas=true tools=false> for this.");
  assert.equal(tools.text, "Use <ctx github full=false schemas=false tools=true> for this.");
});

test("leaves the existing @ syntax untouched", () => {
  const index = createServerIndex(["github"]);
  const result = expandServerMentions("Keep @github available for Pi's file completion.", index, () => "<unexpected>");

  assert.equal(result.changed, false);
  assert.equal(result.text, "Keep @github available for Pi's file completion.");
});

test("parses schema flag and preserves the prompt", () => {
  assert.deepEqual(parseCommandInput("--schemas find open issues"), {
    includeSchemas: true,
    prompt: "find open issues",
  });
  assert.equal(buildEditorText("<ctx/>", "find open issues"), "<ctx/>\n\nfind open issues");
});
