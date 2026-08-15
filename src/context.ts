import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  resourceUri?: string;
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface CachedPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface CachedServerEntry {
  tools?: CachedTool[];
  resources?: CachedResource[];
  prompts?: CachedPrompt[];
  instructions?: string;
  cachedAt?: number;
}

export interface AdapterMetadataCache {
  version?: number;
  servers: Record<string, CachedServerEntry>;
}

export interface AdapterServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount?: number;
  disabled: boolean;
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

const DEFAULT_MAX_CHARS = 12_000;
const SAFE_ALIAS_CHARACTER = /[A-Za-z0-9._-]/;
const SERVER_MENTION_PATTERN = /(^|[\s])#([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/g;

export function getAdapterCachePath(): string {
  const override = process.env.PI_MCP_CONTEXT_CACHE_PATH?.trim();
  if (override) return resolve(expandHome(override));

  const manifest = readPiManifest();
  const appName = manifest?.name ?? "pi";
  const configDir = manifest?.configDir ?? ".pi";
  const envName = `${appName.toUpperCase()}_CODING_AGENT_DIR`;
  const configured = process.env[envName]?.trim();
  const agentDir = configured
    ? resolve(expandHome(configured))
    : join(homedir(), String(configDir).trim() || ".pi", "agent");
  return join(agentDir, "mcp-cache.json");
}

export function loadMetadataCache(path = getAdapterCachePath()): AdapterMetadataCache | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || !isRecord(value.servers)) return null;
    const servers: Record<string, CachedServerEntry> = {};
    for (const [serverName, rawEntry] of Object.entries(value.servers)) {
      const entry = normalizeServerEntry(rawEntry);
      if (entry) servers[serverName] = entry;
    }
    return { version: asNumber(value.version), servers };
  } catch {
    return null;
  }
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
  }

  return { serverNames: unique, aliasByServer, serverByAlias };
}

export function resolveServerReference(index: ServerIndex, reference: string): string | undefined {
  return index.serverByAlias.get(reference) ?? (index.serverNames.includes(reference) ? reference : undefined);
}

export function renderServerContext(
  serverName: string,
  entry: CachedServerEntry | undefined,
  status: AdapterServerStatus | undefined,
  options: RenderContextOptions = {},
): string {
  const includeSchemas = options.includeSchemas === true;
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const state = status?.status ?? (entry ? "cached" : "not-connected");
  const tools = entry?.tools ?? [];
  const resources = entry?.resources ?? [];
  const prompts = entry?.prompts ?? [];
  const serializedServer = JSON.stringify(serverName) ?? "\"\"";
  const lines: string[] = [
    `<mcp-context server="${escapeXml(serverName)}" status="${escapeXml(state)}">`,
    "This is cached metadata for an MCP server managed by pi-mcp-adapter.",
    `When a task matches this server, use the existing mcp proxy with server ${serializedServer}.`,
    `The metadata may be stale; use mcp({ server: ${serializedServer} }) or mcp({ search: "...", server: ${serializedServer} }) when live details are needed.`,
  ];

  if (status?.disabled) {
    lines.push("The adapter currently reports this server as disabled; do not assume its tools are callable.");
  }

  if (entry?.instructions?.trim()) {
    lines.push("<instructions>", escapeXml(entry.instructions.trim()), "</instructions>");
  }

  if (tools.length > 0) {
    lines.push("<tools>");
    for (const tool of tools) {
      const description = oneLine(tool.description) || "(no description)";
      const kind = tool.resourceUri ? ` [resource: ${escapeXml(tool.resourceUri)}]` : "";
      lines.push(`- ${escapeXml(tool.name)}${kind}: ${escapeXml(description)}`);
      if (includeSchemas && tool.inputSchema !== undefined) {
        lines.push(`  schema: ${escapeXml(compactJson(tool.inputSchema, 1_600))}`);
      }
    }
    lines.push("</tools>");
  } else {
    lines.push("No cached MCP tools are available. Ask the mcp proxy to list or search this server.");
  }

  if (resources.length > 0) {
    lines.push("<resources>");
    for (const resource of resources) {
      const description = oneLine(resource.description) || resource.uri;
      lines.push(`- ${escapeXml(resource.name)}: ${escapeXml(resource.uri)} - ${escapeXml(description)}`);
    }
    lines.push("</resources>");
  }

  if (prompts.length > 0) {
    lines.push("<prompts>");
    for (const prompt of prompts) {
      const description = oneLine(prompt.description) || prompt.title || "(no description)";
      lines.push(`- ${escapeXml(prompt.name)}: ${escapeXml(description)}`);
    }
    lines.push("</prompts>");
  }

  const timestamp = formatTimestamp(entry?.cachedAt);
  if (timestamp) {
    lines.push(`Metadata cache timestamp: ${timestamp}.`);
  }

  lines.push("</mcp-context>");
  return truncateBlock(lines.join("\n"), maxChars);
}

export function expandServerMentions(
  text: string,
  index: ServerIndex,
  render: (serverName: string) => string,
): { text: string; changed: boolean; servers: string[] } {
  const servers: string[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(SERVER_MENTION_PATTERN, (whole, whitespace: string, reference: string) => {
    const serverName = resolveServerReference(index, reference);
    if (!serverName) return whole;
    if (!seen.has(serverName)) {
      seen.add(serverName);
      servers.push(serverName);
    }
    return `${whitespace}${render(serverName)}`;
  });
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

function toSafeAlias(value: string): string {
  return [...value].map((character) => {
    if (SAFE_ALIAS_CHARACTER.test(character)) return character;
    return `_${character.codePointAt(0)!.toString(16)}_`;
  }).join("");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function readPiManifest(): { name?: string; configDir?: string } | undefined {
  const packageDir = process.env.PI_PACKAGE_DIR?.trim();
  if (!packageDir) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(join(resolve(packageDir), "package.json"), "utf8"));
    if (!isRecord(value) || !isRecord(value.piConfig)) return undefined;
    return {
      name: typeof value.piConfig.name === "string" ? value.piConfig.name : undefined,
      configDir: typeof value.piConfig.configDir === "string" ? value.piConfig.configDir : undefined,
    };
  } catch {
    return undefined;
  }
}

function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const closing = "\n</mcp-context>";
  const marker = "\n[metadata truncated; use the mcp proxy for the complete catalog]";
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
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function normalizeServerEntry(value: unknown): CachedServerEntry | undefined {
  if (!isRecord(value)) return undefined;
  const entry: CachedServerEntry = {};
  const tools = Array.isArray(value.tools) ? value.tools.map(normalizeTool).filter(isDefined) : undefined;
  const resources = Array.isArray(value.resources) ? value.resources.map(normalizeResource).filter(isDefined) : undefined;
  const prompts = Array.isArray(value.prompts) ? value.prompts.map(normalizePrompt).filter(isDefined) : undefined;
  if (tools) entry.tools = tools;
  if (resources) entry.resources = resources;
  if (prompts) entry.prompts = prompts;
  if (typeof value.instructions === "string") entry.instructions = value.instructions;
  if (typeof value.cachedAt === "number" && Number.isFinite(value.cachedAt)) entry.cachedAt = value.cachedAt;
  return entry;
}

function normalizeTool(value: unknown): CachedTool | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return undefined;
  const tool: CachedTool = { name: value.name };
  if (typeof value.description === "string") tool.description = value.description;
  if (value.inputSchema !== undefined) tool.inputSchema = value.inputSchema;
  if (typeof value.resourceUri === "string") tool.resourceUri = value.resourceUri;
  return tool;
}

function normalizeResource(value: unknown): CachedResource | undefined {
  if (!isRecord(value) || typeof value.uri !== "string" || typeof value.name !== "string") return undefined;
  return {
    uri: value.uri,
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

function normalizePrompt(value: unknown): CachedPrompt | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return undefined;
  return {
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function formatTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function oneLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
