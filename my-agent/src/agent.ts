import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { llm, voice } from "@livekit/agents";
import { z } from "zod";

// Simple cache — one set of tables for the lifetime of the process
let cachedTables: string[] | null = null;

async function getKnownTables(
  mcpTools: Record<string, llm.FunctionTool<any>>
): Promise<string[]> {
  if (cachedTables !== null) {
    console.log(`📋 Using cached tables`);
    return cachedTables;
  }

  const querySqlTool = mcpTools["query_sql"] as any;
  if (!querySqlTool?.execute) {
    console.warn("⚠️  query_sql tool not found, skipping table discovery");
    return [];
  }

  try {
    const result = await querySqlTool.execute(
      {
        sql: "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        limit: 200,
      },
      {
        toolCallId: "known-tables-cache",
        messages: [],
      }
    );

    const textContent = (
      result?.content as Array<{ type?: string; text?: string }> | undefined
    )?.find((entry) => entry.type === "text")?.text;

    if (!textContent) return [];

    const parsed = JSON.parse(textContent) as {
      rows?: Array<{ name?: string }>;
    };

    cachedTables =
      parsed.rows
        ?.map((row) => row.name)
        .filter((name): name is string => Boolean(name)) ?? [];

    console.log(`📊 Discovered ${cachedTables.length} tables`);
    return cachedTables;
  } catch (e) {
    console.warn("⚠️  Failed to fetch known tables:", e);
    return [];
  }
}

function buildSystemPrompt(tableHint: string): string {
  return (
    "You are an AI assistant connected to a surveilr Resource Surveillance State Database (RSSD) via an MCP server. " +
    "Your primary capability is answering questions by generating and executing SQL queries against the RSSD — a read-only SQLite database.\n\n" +
    "Use a 'Progressive Discovery' strategy: start with lightweight tools and escalate only when needed. " +
    "You have a maximum of 15 tool calls per response — use them efficiently.\n\n" +
    "Core Constraints:\n" +
    "- Read-only: Only SELECT statements are permitted. Never attempt INSERT, UPDATE, DELETE, DROP, or any DDL.\n" +
    "- Row limits: Queries return 10 rows by default, max 50 rows. Request more explicitly only when truly necessary.\n" +
    "- Text truncation: All text fields are truncated at 200 characters. If a value ends with '... (N chars total)', the full value is longer than displayed.\n" +
    "- Step budget: You have at most 15 tool calls per response. Prefer the minimum number of calls needed.\n\n" +
    "Available MCP Tools:\n" +
    "1. Schema Discovery (use these FIRST):\n" +
    "   - list_tables(): ~50-100 tokens. Use at the start of a new conversation to see what tables exist.\n" +
    "   - get_table_columns(table_name): ~50-200 tokens. Use once you know which tables are relevant.\n" +
    "   - get_table_metadata(table_name): Detailed column definitions for a specific table.\n" +
    "   - get_schema_compact(): ~2k-5k tokens. Use when you need a broad overview of the full database structure.\n" +
    "   - get_schema(): ~25k-80k tokens. Use only when full metadata and row counts are explicitly required.\n\n" +
    "2. Data Sampling:\n" +
    "   - get_table_sample(table_name): Returns first 3 rows from a table; text fields truncated to 200 chars.\n" +
    "   - get_table_stats(table_name): Get row count and basic stats for a table.\n\n" +
    "3. Query Execution:\n" +
    "   - query_sql(sql, limit?): Execute a SELECT query. Default 10 rows, max 50 rows.\n\n" +
    "4. Ontology Tools:\n" +
    "   - query_ontology(concept): Look up a concept in the RSSD ontology.\n" +
    "   - explore_concept(class_name): Explore relationships connected to an ontology class.\n" +
    "   - list_ontology(): List available ontology classes.\n\n" +
    "Optimal Text-to-SQL Workflow:\n" +
    "1. MAP: Call list_tables() first to identify candidate tables.\n" +
    "2. DRILL: Call get_table_columns(table_name) for 1-2 relevant tables.\n" +
    "3. INSPECT: Call get_table_sample(table_name) to see example values.\n" +
    "4. QUERY: Use query_sql with narrow SELECT statements and specific WHERE clauses.\n\n" +
    "Analysis & Recommendations:\n" +
    "- After retrieving data, ALWAYS provide analysis and actionable recommendations.\n" +
    "- Never refuse to provide recommendations simply because you are a database tool.\n" +
    "- If the data is insufficient, state what data was found and what additional data would help.\n\n" +
    "Behavioral Rules:\n" +
    "1. Always start with list_tables() on the FIRST turn of a conversation.\n" +
    "2. Never call get_schema() unless the user explicitly asks for full schema metadata.\n" +
    "3. Chain tools efficiently: list_tables -> get_table_columns -> query_sql.\n" +
    "4. Validate before querying: Confirm table and column names exist.\n" +
    "5. Explain truncation: If a text result ends with '... (N chars total)', inform the user.\n" +
    "6. Limit discipline: Default to limit=10. Only increase to max 50 if needed.\n" +
    "7. SQL safety: Never generate or execute non-SELECT SQL.\n" +
    "8. Surface ontology when relevant for concepts, classifications, or taxonomy.\n" +
    "9. Empty results: If a query returns no rows, suggest possible reasons.\n" +
    "10. Silent execution: Never narrate tool calls or intermediate findings.\n\n" +
    "Voice-specific rules (IMPORTANT — this is a voice interface):\n" +
    "- Always respond in natural spoken language. No bullet points, no markdown, no numbered lists.\n" +
    "- Convert any data findings into flowing sentences a human would speak aloud.\n" +
    "- Keep responses concise — summarize findings rather than reading raw data row by row.\n" +
    "- If results are large, highlight the most important findings only." +
    tableHint
  );
}

async function buildMCPTools(): Promise<{ tools: Record<string, llm.FunctionTool<any>>; client: Client }> {
  const client = new Client({ name: "livekit-mcp-bridge", version: "1.0.0" });

  const transport = new StdioClientTransport({
    command: "surveilr",
    args: ["mcp", "server", "-d", "/home/ashinisa/livekit-mcp/my-agent/resource-surveillance.sqlite.db"],
    env: process.env as Record<string, string>,
  });

  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolMap: Record<string, llm.FunctionTool<any>> = {};

  for (const tool of tools) {
    const toolName = tool.name;
    const schema = tool.inputSchema as any;
    const properties = schema.properties ?? {};
    const required: string[] = schema.required ?? [];

    toolMap[toolName] = llm.tool({
      description: tool.description ?? toolName,
      parameters: z.object(
        Object.fromEntries(
          Object.entries(properties).map(([key, val]: [string, any]) => {
            let zodType: z.ZodTypeAny;
            switch (val.type) {
              case "integer":
              case "number":
                zodType = z.number().describe(val.description ?? key);
                break;
              case "boolean":
                zodType = z.boolean().describe(val.description ?? key);
                break;
              case "array":
                zodType = z.array(z.any()).describe(val.description ?? key);
                break;
              case "object":
                zodType = z.record(z.any()).describe(val.description ?? key);
                break;
              default:
                zodType = z.string().describe(val.description ?? key);
            }
            if (!required.includes(key)) {
              zodType = zodType.optional();
            }
            return [key, zodType];
          })
        )
      ),
      execute: async (args) => {
        const coerced: Record<string, any> = {};
        for (const [key, val] of Object.entries(args as Record<string, any>)) {
          const propType = properties[key]?.type;
          if ((propType === "integer" || propType === "number") && typeof val === "string") {
            coerced[key] = Number(val);
          } else {
            coerced[key] = val;
          }
        }
        console.log(`🔧 Calling tool: ${toolName}`, coerced);
        const result = await client.callTool({ name: toolName, arguments: coerced });
        return (result.content as any[])
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      },
    });
  }

  return { tools: toolMap, client };
}

export class Agent extends voice.Agent {
  private mcpClient: Client | null = null;

  constructor() {
    super({
      instructions: "You are a helpful database assistant. Initializing...",
    });
  }

  override async onEnter(): Promise<void> {
    console.log("🔌 Connecting to MCP server (surveilr)...");

    const { tools, client } = await buildMCPTools();
    this.mcpClient = client;

    const toolNames = Object.keys(tools);
    console.log(`✅ MCP connected! Found ${toolNames.length} tools:`);
    toolNames.forEach((name) => console.log(`   - ${name}`));

    // Discover all tables and build full prompt with table hints
    const knownTables = await getKnownTables(tools);
    console.log(`📊 Known tables: ${knownTables.length}`);

    const tableHint = knownTables.length
      ? `\n\nAvailable tables and views in the RSSD (use exact names):\n${knownTables.join(", ")}.`
      : "";

    // Update instructions with real table names before first reply
    const newInstructions = buildSystemPrompt(tableHint);
    const newChatCtx = this.chatCtx.copy();
    const systemMessage = newChatCtx.items.find(
      (item) => item.type === "message" && (item.role === "system" || item.role === "developer")
    );

    if (systemMessage && systemMessage.type === "message") {
      systemMessage.content = [newInstructions];
    } else {
      newChatCtx.addMessage({ role: "system", content: newInstructions });
    }

    await this.updateChatCtx(newChatCtx);

    // Register all MCP tools
    await this.updateTools(tools);

    // Greet the user
    this.session.generateReply({
      instructions:
        "Greet the user warmly. Let them know you are connected to the surveilr database and ready to answer questions.",
    });
  }

  override async onExit(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
  }
}