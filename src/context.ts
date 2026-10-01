import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

export type NativeToolExposure = "codemode" | "deferred" | "direct" | "hidden" | "mixed" | string;

export interface NativeToolNamespace {
  name: string;
  description?: string;
  instructions?: string;
}

/** Structural subset of Pi's ToolInfo used by the pure snapshot builder. */
export interface NativeToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  exposure?: NativeToolExposure;
  namespace?: NativeToolNamespace;
}

export interface NativeMcpTool {
  name: string;
  description?: string;
  parameters?: unknown;
  exposure?: NativeToolExposure;
  namespace: NativeToolNamespace;
}

export interface NativeMcpServer {
  name: string;
  namespace: NativeToolNamespace;
  exposure?: NativeToolExposure;
  tools: NativeMcpTool[];
}

export interface NativeMcpSnapshot {
  servers: NativeMcpServer[];
}

export interface NativeMcpServerHint {
  name: string;
  namespace: NativeToolNamespace;
  exposure?: NativeToolExposure;
}

export interface ServerIndex {
  serverNames: string[];
  aliasByServer: Map<string, string>;
  serverByAlias: Map<string, string>;
}

export interface RenderContextOptions {
  includeSchemas?: boolean;
  maxChars?: number;
}

export interface CommandInputOptions {
  includeSchemas: boolean;
  prompt: string;
}

export interface MentionRenderOptions {
  /** --full / --schemas: expand to the complete currently registered catalog. */
  full?: boolean;
  /** --schemas / --schema: include input schemas in the full render. */
  includeSchemas?: boolean;
  /** -t / --tools: include qualified tool names without schemas. */
  listTools?: boolean;
}

const DEFAULT_MAX_CHARS = 12_000;
const MAX_TOOL_NAMES = 40;
const SAFE_ALIAS_CHARACTER = /[A-Za-z0-9._-]/;
const MCP_NAMESPACE_PREFIX = "mcp__";
const SERVER_MENTION_PATTERN =
  /(^|[\s])#([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)((?:\s+(?:-t|--tools|-f|--full|--schema|--schemas))*)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g;

/**
 * Build a Pi-native MCP snapshot from registered tools and the structured
 * `mcp_servers` system-prompt section. No MCP client, cache, or adapter event
 * is involved.
 */
export function createNativeMcpSnapshot(
  tools: readonly NativeToolInfo[],
  mcpServersSection = "",
): NativeMcpSnapshot {
  const byNamespace = new Map<string, NativeMcpServer>();

  for (const hint of parseMcpServersSection(mcpServersSection)) {
    byNamespace.set(hint.namespace.name, {
      name: hint.name,
      namespace: hint.namespace,
      exposure: hint.exposure,
      tools: [],
    });
  }

  for (const tool of tools) {
    const namespace = getMcpNamespace(tool);
    if (!namespace) continue;

    const existing = byNamespace.get(namespace.name);
    const server: NativeMcpServer = existing ?? {
      name: namespace.name.slice(MCP_NAMESPACE_PREFIX.length),
      namespace,
      tools: [],
    };
    server.namespace = mergeNamespace(server.namespace, namespace);
    server.exposure = mergeExposure(server.exposure, tool.exposure);

    const duplicate = server.tools.some(
      (candidate) => candidate.name === tool.name && candidate.namespace.name === namespace.name,
    );
    if (!duplicate) {
      server.tools.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure,
        namespace,
      });
    }
    byNamespace.set(namespace.name, server);
  }

  const servers = [...byNamespace.values()]
    .map((server) => ({
      ...server,
      tools: [...server.tools].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { servers };
}

/** Parse Pi's one-line `mcp_servers` prompt section without treating it as a status API. */
export function parseMcpServersSection(section: string): NativeMcpServerHint[] {
  const hints: NativeMcpServerHint[] = [];
  const seen = new Set<string>();
  const text = section.replace(/<\/?mcp_servers>/g, "");

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(mcp__[A-Za-z0-9_]+)(?:\s+\(([^)]+)\))?(?:\s*:\s*(.*))?\s*$/);
    if (!match) continue;

    const namespaceName = match[1]!;
    if (seen.has(namespaceName)) continue;
    seen.add(namespaceName);

    const exposure = normalizeExposure(match[2]);
    const description = match[3]?.trim();
    hints.push({
      name: namespaceName.slice(MCP_NAMESPACE_PREFIX.length),
      namespace: {
        name: namespaceName,
        ...(description ? { description } : {}),
      },
      ...(exposure ? { exposure } : {}),
    });
  }

  return hints;
}

export function createServerIndex(serverNames: readonly string[]): ServerIndex {
  const unique = [...new Set(serverNames.filter((name) => name.trim().length > 0))].sort();
  const aliasByServer = new Map<string, string>();
  const serverByAlias = new Map<string, string>();

  for (const serverName of unique) {
    const base = toSafeAlias(serverName) || "server";
    let alias = base;
    let suffix = 2;
    while (serverByAlias.has(alias)) alias = `${base}-${suffix++}`;
    aliasByServer.set(serverName, alias);
    serverByAlias.set(alias, serverName);

    const normalized = normalizeServerReference(serverName);
    if (normalized !== serverName && !serverByAlias.has(normalized)) {
      serverByAlias.set(normalized, serverName);
    }
  }

  return { serverNames: unique, aliasByServer, serverByAlias };
}

export function filterServerCompletions(
  items: readonly AutocompleteItem[],
  query: string,
): AutocompleteItem[] {
  const normalized = query.trim();
  if (normalized.length === 0) return [...items];
  return fuzzyFilter([...items], normalized, (item) => item.label);
}

export function resolveServerReference(index: ServerIndex, reference: string): string | undefined {
  if (index.serverNames.includes(reference)) return reference;
  const normalized = normalizeServerReference(reference);
  if (index.serverNames.includes(normalized)) return normalized;
  return index.serverByAlias.get(reference) ?? index.serverByAlias.get(normalized);
}

export function renderServerUse(server: NativeMcpServer): string {
  const namespace = server.namespace.name;
  const lines = [
    `<use-mcp server="${escapeXml(server.name)}" namespace="${escapeXml(namespace)}"${exposureAttribute(server)}>` ,
    `Use the Pi-native MCP namespace ${JSON.stringify(namespace)} for this task.`,
    `Inside codemode, discover matching tools with searchTools("...", { namespace: ${JSON.stringify(namespace)} })`,
    `or inspect the namespace with describeNamespace(${JSON.stringify(namespace)}).`,
    `Call a selected tool with tools.mcp__server__tool(args), replacing it with the qualified name; for example tools.${qualifiedExample(server)}({...}).`,
  ];
  if (server.exposure === "deferred") {
    lines.push("This namespace uses deferred exposure; tool_search can load matching tools for the next model call.");
  }
  if (server.tools.length === 0) {
    lines.push("No tool metadata is currently registered in this context; use builtin:mcp /mcp for connection or authentication diagnostics.");
  }
  lines.push("</use-mcp>");
  return lines.join("\n");
}

export function renderServerUseWithTools(server: NativeMcpServer): string {
  const namespace = server.namespace.name;
  const names = server.tools.map((tool) => tool.name).filter(Boolean);
  const shown = names.slice(0, MAX_TOOL_NAMES);
  const tail = names.length > MAX_TOOL_NAMES ? ` +${names.length - MAX_TOOL_NAMES} more` : "";
  const toolList = shown.length > 0 ? `${shown.join(", ")}${tail}` : "(no registered tool names)";
  const lines = [
    `<use-mcp server="${escapeXml(server.name)}" namespace="${escapeXml(namespace)}"${exposureAttribute(server)}>` ,
    `Use ${namespace} with these currently registered qualified tools: ${toolList}.`,
    `Use describeNamespace(${JSON.stringify(namespace)}) for namespace instructions and searchTools() for matching tools.`,
    `Call a selected tool through codemode as tools.<qualified_name>(args).`,
    "</use-mcp>",
  ];
  return lines.join("\n");
}

export function renderServerContext(
  server: NativeMcpServer,
  options: RenderContextOptions = {},
): string {
  const includeSchemas = options.includeSchemas === true;
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const namespace = server.namespace.name;
  const lines: string[] = [
    `<mcp-context server="${escapeXml(server.name)}" namespace="${escapeXml(namespace)}"${exposureAttribute(server)}>` ,
    "This is Pi-native MCP metadata. Pi builtin:mcp owns connections, authentication, and calls.",
    `Discover with searchTools("...", { namespace: ${JSON.stringify(namespace)} }) or describeNamespace(${JSON.stringify(namespace)}).`,
    `Call a selected tool through codemode as tools.mcp__server__tool(args), replacing it with the qualified name; for example tools.${qualifiedExample(server)}(args).`,
  ];

  if (server.namespace.description?.trim()) {
    lines.push(`Description: ${escapeXml(oneLine(server.namespace.description))}`);
  }
  if (server.namespace.instructions?.trim()) {
    lines.push("<instructions>", escapeXml(server.namespace.instructions.trim()), "</instructions>");
  }

  if (server.tools.length > 0) {
    lines.push("<tools>");
    for (const tool of server.tools) {
      const description = oneLine(tool.description) || "(no description)";
      const exposure = tool.exposure ? ` [${escapeXml(tool.exposure)}]` : "";
      lines.push(`- ${escapeXml(tool.name)}${exposure}: ${escapeXml(description)}`);
      if (includeSchemas && tool.parameters !== undefined) {
        lines.push(`  schema: ${escapeXml(compactJson(tool.parameters, 1_600))}`);
      }
    }
    lines.push("</tools>");
  } else {
    lines.push(
      "No currently registered tool metadata is available for this namespace. Use builtin:mcp /mcp for connection or authentication diagnostics, then retry discovery.",
    );
  }

  lines.push("</mcp-context>");
  return truncateBlock(lines.join("\n"), maxChars, namespace);
}

export function expandServerMentions(
  text: string,
  index: ServerIndex,
  render: (serverName: string, options: MentionRenderOptions) => string,
): { text: string; changed: boolean; servers: string[] } {
  const servers: string[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(
    SERVER_MENTION_PATTERN,
    (whole, whitespace: string, reference: string, modifiers: string) => {
      const serverName = resolveServerReference(index, reference);
      if (!serverName) return whole;
      if (!seen.has(serverName)) {
        seen.add(serverName);
        servers.push(serverName);
      }
      const includeSchemas = /--(?:schema|schemas)/.test(modifiers);
      const full = includeSchemas || /--full|-f/.test(modifiers);
      const listTools = !full && /(?:^|\s)(?:-t|--tools)(?:\s|$)/.test(modifiers);
      return `${whitespace}${render(serverName, { full, includeSchemas, listTools })}`;
    },
  );
  return { text: expanded, changed: expanded !== text, servers };
}

export function parseCommandInput(args: string): CommandInputOptions {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const includeSchemas = words.some((word) => word === "--schemas" || word === "--schema");
  return {
    includeSchemas,
    prompt: words.filter((word) => word !== "--schemas" && word !== "--schema").join(" "),
  };
}

export function buildEditorText(context: string, prompt: string): string {
  return prompt.trim().length > 0 ? `${context}\n\n${prompt.trim()}` : context;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getMcpNamespace(tool: NativeToolInfo): NativeToolNamespace | undefined {
  const namespace = tool.namespace;
  if (namespace?.name.startsWith(MCP_NAMESPACE_PREFIX)) return namespace;
  const separator = tool.name.lastIndexOf("__");
  if (!tool.name.startsWith(MCP_NAMESPACE_PREFIX) || separator <= MCP_NAMESPACE_PREFIX.length) return undefined;
  return { name: tool.name.slice(0, separator) };
}

function mergeNamespace(left: NativeToolNamespace, right: NativeToolNamespace): NativeToolNamespace {
  return {
    name: left.name,
    ...(left.description || right.description ? { description: left.description ?? right.description } : {}),
    ...(left.instructions || right.instructions ? { instructions: left.instructions ?? right.instructions } : {}),
  };
}

function mergeExposure(left: NativeToolExposure | undefined, right: NativeToolExposure | undefined): NativeToolExposure | undefined {
  if (!right) return left;
  if (!left || left === right) return left ?? right;
  return "mixed";
}

function normalizeExposure(value: string | undefined): NativeToolExposure | undefined {
  const exposure = value?.trim();
  if (!exposure) return undefined;
  if (exposure === "tool_search") return "deferred";
  if (["codemode", "deferred", "direct", "hidden", "mixed"].includes(exposure)) return exposure;
  return undefined;
}

function normalizeServerReference(value: string): string {
  return value.replace(/^mcp__/, "").replace(/-/g, "_");
}

function toSafeAlias(value: string): string {
  return [...value]
    .map((character) => {
      if (SAFE_ALIAS_CHARACTER.test(character)) return character;
      return `_${character.codePointAt(0)!.toString(16)}_`;
    })
    .join("");
}

function exposureAttribute(server: NativeMcpServer): string {
  return server.exposure ? ` exposure="${escapeXml(server.exposure)}"` : "";
}

function qualifiedExample(server: NativeMcpServer): string {
  return server.tools[0]?.name ?? `${server.namespace.name}__tool_name`;
}

function truncateBlock(value: string, maxChars: number, namespace: string): string {
  if (value.length <= maxChars) return value;
  const closing = "\n</mcp-context>";
  const marker = `\n[context truncated; use describeNamespace(${JSON.stringify(namespace)}) for the complete namespace]`;
  const end = value.endsWith("</mcp-context>") ? closing : "";
  const available = Math.max(0, maxChars - marker.length - end.length);
  return `${value.slice(0, available)}${marker}${end}`;
}

function compactJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function oneLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
