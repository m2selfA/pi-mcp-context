import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildEditorText,
  createNativeMcpSnapshot,
  createServerIndex,
  expandServerMentions,
  filterServerCompletions,
  parseCommandInput,
  renderServerContext,
  renderServerUse,
  renderServerUseWithTools,
  resolveServerReference,
  type MentionRenderOptions,
  type NativeMcpServer,
  type NativeMcpSnapshot,
} from "./context.ts";

const SELECT_COMMAND = "mcp:select";

export default function piMcpContext(pi: ExtensionAPI): void {
  let mcpServersSection = "";
  let snapshot: NativeMcpSnapshot = { servers: [] };
  let index = createServerIndex([]);
  const registeredServerCommands = new Set<string>();
  let autocompleteInstalled = false;

  const refreshInventory = (): void => {
    snapshot = createNativeMcpSnapshot(pi.getAllTools(), mcpServersSection);
    index = createServerIndex(snapshot.servers.map((server) => server.name));
    registerServerCommands();
  };

  pi.registerCommand(SELECT_COMMAND, {
    description: "Choose a Pi-native MCP namespace and prepare its context in the editor.",
    handler: async (args, ctx) => {
      refreshInventory();
      if (!ctx.hasUI) {
        notify(ctx, "MCP namespace selection requires an interactive UI.", "warning");
        return;
      }
      if (index.serverNames.length === 0) {
        notify(ctx, "No Pi-native MCP namespaces are currently visible. Run /mcp, then retry.", "warning");
        return;
      }
      const choices = index.serverNames.map((name) => ({
        label: formatServerChoice(name),
        serverName: name,
      }));
      const selected = await ctx.ui.select("Choose a Pi-native MCP namespace", choices.map((choice) => choice.label));
      if (!selected) return;
      const choice = choices.find((candidate) => candidate.label === selected);
      if (!choice) return;
      await prepareEditor(choice.serverName, args, ctx);
    },
  });

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
    if (sections) {
      mcpServersSection = sections.mcp_servers ?? "";
    }
    refreshInventory();
  });

  pi.on("session_start", (_event, ctx) => {
    refreshInventory();
    if (ctx.mode === "tui" && !autocompleteInstalled) {
      installAutocomplete(ctx);
      autocompleteInstalled = true;
    }
  });

  pi.on("session_shutdown", () => {
    snapshot = { servers: [] };
    index = createServerIndex([]);
    mcpServersSection = "";
    autocompleteInstalled = false;
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    refreshInventory();

    if (event.text.includes("#")) {
      const expanded = expandServerMentions(event.text, index, (serverName, options) =>
        renderMention(serverName, options),
      );
      if (expanded.changed) return { action: "transform" as const, text: expanded.text };
    }

    // Race-safe fallback for a slash command typed before a dynamic command is registered.
    const match = event.text.match(/^\s*\/mcp:([A-Za-z0-9._-]+)(?:\s+([\s\S]*?))?\s*$/);
    if (!match) return;
    const serverName = resolveServerReference(index, match[1]!);
    if (!serverName) return;
    const parsed = parseCommandInput(match[2] ?? "");
    return {
      action: "transform" as const,
      text: buildEditorText(renderContext(serverName, parsed.includeSchemas), parsed.prompt),
    };
  });

  // Pi action methods such as getAllTools() are not available during extension loading.
  // The first inventory refresh happens at session_start or before_agent_start.

  function registerServerCommands(): void {
    for (const serverName of index.serverNames) {
      const alias = index.aliasByServer.get(serverName);
      if (!alias) continue;
      const commandName = `mcp:${alias}`;
      if (registeredServerCommands.has(commandName)) continue;
      registeredServerCommands.add(commandName);
      pi.registerCommand(commandName, {
        description: `Prepare Pi-native MCP context for ${serverName}.`,
        handler: async (args, ctx) => {
          refreshInventory();
          const resolved = index.serverNames.includes(serverName) ? serverName : undefined;
          if (!resolved) {
            notify(ctx, `MCP namespace "${serverName}" is no longer visible.`, "warning");
            return;
          }
          await prepareEditor(resolved, args, ctx);
        },
      });
    }
  }

  function installAutocomplete(ctx: ExtensionContext): void {
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["#", ":"],
      async getSuggestions(lines, line, col, options) {
        refreshInventory();
        const before = (lines[line] ?? "").slice(0, col);
        const mention = before.match(/(?:^|[ \t])#([A-Za-z0-9._-]*)$/);
        if (mention) {
          const prefix = `#${mention[1] ?? ""}`;
          return {
            prefix,
            items: index.serverNames.map((serverName) => {
              const alias = index.aliasByServer.get(serverName)!;
              return {
                value: `#${alias}`,
                label: `#${alias}`,
                description: describeServer(serverName),
              };
            }),
          };
        }

        const slash = before.match(/^\/mcp:([A-Za-z0-9._-]*)$/);
        if (slash) {
          const prefix = `/mcp:${slash[1] ?? ""}`;
          const items = [
            {
              value: "mcp:select",
              label: "/mcp:select",
              description: "Choose a Pi-native MCP namespace",
            },
            ...index.serverNames.map((serverName) => {
              const alias = index.aliasByServer.get(serverName)!;
              return {
                value: `mcp:${alias}`,
                label: `/mcp:${alias}`,
                description: describeServer(serverName),
              };
            }),
          ];
          return {
            prefix,
            items: filterServerCompletions(items, slash[1] ?? ""),
          };
        }

        return current.getSuggestions(lines, line, col, options);
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  }

  async function prepareEditor(serverName: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = parseCommandInput(args);
    const text = buildEditorText(renderContext(serverName, parsed.includeSchemas), parsed.prompt);
    if (!ctx.hasUI) {
      pi.sendUserMessage(text);
      return;
    }
    ctx.ui.setEditorText(text);
    notify(ctx, `Prepared Pi-native MCP context for ${serverName}. Review it in the editor and submit.`, "info");
  }

  function renderMention(serverName: string, options: MentionRenderOptions): string {
    const server = getServer(serverName);
    if (options.full) return renderServerContext(server, { includeSchemas: options.includeSchemas === true });
    if (options.listTools) return renderServerUseWithTools(server);
    return renderServerUse(server);
  }

  function renderContext(serverName: string, includeSchemas = false): string {
    return renderServerContext(getServer(serverName), { includeSchemas });
  }

  function getServer(serverName: string): NativeMcpServer {
    return (
      snapshot.servers.find((server) => server.name === serverName) ?? {
        name: serverName,
        namespace: { name: `mcp__${serverName.replace(/-/g, "_")}` },
        tools: [],
      }
    );
  }

  function describeServer(serverName: string): string {
    const server = getServer(serverName);
    const exposure = server.exposure ? `, ${server.exposure}` : "";
    const count = server.tools.length === 0 ? "no registered tools" : `${server.tools.length} tools`;
    return `${server.namespace.name} (${count}${exposure})`;
  }

  function formatServerChoice(serverName: string): string {
    const alias = index.aliasByServer.get(serverName) ?? serverName;
    return `${alias} - ${serverName} — ${describeServer(serverName)}`;
  }

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }
}
