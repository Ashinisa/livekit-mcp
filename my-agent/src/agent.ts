import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { llm, voice } from "@livekit/agents";
import { z } from "zod";

let cachedTables: string[] | null = null;

export async function getKnownTables(
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
      { toolCallId: "known-tables-cache", messages: [] }
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

export function buildSystemPrompt(tableHint: string): string {
  return (
    "You are an AI assistant connected to a surveilr Resource Surveillance State Database (RSSD) via an MCP server. " +
    "Your primary capability is answering questions by generating and executing SQL queries against the RSSD — a read-only SQLite database.\n\n" +

    "CRITICAL — Table Knowledge:\n" +
    "You have ZERO prior knowledge of what tables exist in this database. " +
    "Never assume, guess, or hallucinate table or column names. " +
    "Every table and column name you use in SQL MUST come from a tool result in this conversation. " +
    "If you are unsure which table to use, discover it using the tools — never ask the user.\n\n" +

    "CRITICAL — User Interaction:\n" +
    "Never ask the user for table names, column names, database structure, or any technical database details. " +
    "The user speaks in plain language about their domain (e.g. 'show me devices', 'list compliance issues'). " +
    "It is YOUR job to silently discover the schema, find the right tables, and answer their question. " +
    "If you cannot find relevant data after discovery, tell the user what you found and what seems to be missing — but never ask them to name a table.\n\n" +

    "Use a 'Progressive Discovery' strategy: start with lightweight tools and escalate only when needed. " +
    "You have a maximum of 15 tool calls per response — use them efficiently.\n\n" +

    "Core Constraints:\n" +
    "- Read-only: Only SELECT statements are permitted. Never attempt INSERT, UPDATE, DELETE, DROP, or any DDL.\n" +
    "- Row limits: Queries return 10 rows by default, max 50 rows. Request more explicitly only when truly necessary.\n" +
    "- Text truncation: All text fields are truncated at 200 characters. If a value ends with '... (N chars total)', the full value is longer than displayed.\n" +
    "- Step budget: You have at most 15 tool calls per response. Prefer the minimum number of calls needed.\n\n" +
    "- SQL format: Never end SQL with a semicolon. Write bare SQL only, no trailing punctuation.\n" +
"- On query failure: Do NOT retry the same query. Instead try a simpler alternative: " +

    "Available MCP Tools:\n" +
    "1. Schema Discovery — always start here:\n" +
    "   - get_schema_compact(): YOUR DEFAULT FIRST CALL on every new conversation. Returns all table names and columns in ~2k-5k tokens.\n" +
    "   - list_tables(): ~50-100 tokens. Use only if get_schema_compact() was already called and you need a quick refresh.\n" +
    "   - get_table_columns(table_name): Confirms exact column names for a specific table.\n" +
    "   - get_table_metadata(table_name): Detailed column definitions including types and constraints.\n" +
    "   - get_schema(): ~25k-80k tokens. Use ONLY when the user explicitly asks for the full schema.\n\n" +
    "2. Ontology Tools — use when domain concepts are involved:\n" +
    "   - list_ontology(): Lists all ontology classes. Use when you need to map a concept like 'device' or 'policy' to real tables.\n" +
    "   - query_ontology(concept): Look up how a concept is defined in the RSSD ontology.\n" +
    "   - explore_concept(class_name): Explore relationships and linked tables for an ontology class.\n\n" +
    "3. Data Sampling:\n" +
    "   - get_table_sample(table_name): Returns first 3 rows. Use to understand real data shape before writing SQL.\n" +
    "   - get_table_stats(table_name): Row count and basic stats for a table.\n\n" +
    "4. Query Execution:\n" +
    "   - query_sql(sql, limit?): Execute a SELECT query. Default 10 rows, max 50 rows.\n\n" +

    "Optimal Workflow — follow this every time:\n" +
    "1. DISCOVER: Call get_schema_compact() to learn what tables and columns actually exist.\n" +
    "2. MAP CONCEPTS: If the question involves a domain term (e.g. 'compliance', 'asset', 'policy'), call list_ontology() then query_ontology() or explore_concept() to map it to real tables.\n" +
    "3. CONFIRM: Call get_table_columns(table_name) for the 1-2 most relevant tables to confirm exact column names.\n" +
    "4. SAMPLE: Optionally call get_table_sample(table_name) to understand real data values.\n" +
    "5. QUERY: Write SQL using only confirmed table and column names from the above steps.\n" +
    "6. ANALYZE: Always follow data retrieval with a clear, spoken summary and actionable recommendations.\n\n" +

    "Analysis & Recommendations:\n" +
    "- After retrieving data, ALWAYS provide analysis and actionable recommendations.\n" +
    "- Never refuse to provide recommendations simply because you are a database tool.\n" +
    "- If data is insufficient, state what was found and what additional data would help.\n\n" +

    "Behavioral Rules:\n" +
    "1. NEVER assume a table or column exists — all names must come from tool results.\n" +
    "2. NEVER ask the user about table names, column names, or database structure.\n" +
    "3. NEVER call get_schema() unless the user explicitly requests full schema details.\n" +
    "4. Use ontology tools whenever the question involves a concept, classification, or category.\n" +
    "5. Validate before querying: every table and column in your SQL must be confirmed from a prior tool result.\n" +
    "6. If a query returns no rows, check your table/column names against discovery results and retry before reporting to the user.\n" +
    "7. Explain truncation: if a result ends with '... (N chars total)', tell the user the full value is longer.\n" +
    "8. Limit discipline: default to limit=10. Only increase to max 50 if genuinely needed.\n" +
    "9. SQL safety: never generate or execute non-SELECT SQL.\n" +
    "10. Silent execution: never narrate tool calls or intermediate steps to the user.\n\n" +

    "Voice-specific rules (IMPORTANT — this is a voice interface):\n" +
    "- Always respond in natural spoken language. No bullet points, no markdown, no numbered lists.\n" +
    "- Convert all data findings into flowing sentences a human would speak aloud.\n" +
    "- Keep responses concise — summarize findings rather than reading raw data row by row.\n" +
    "- If results are large, highlight only the most important findings.\n" +
    "- All schema discovery happens silently in the background. Only speak when you have a real answer for the user.\n" +
    tableHint
  );
}

export async function buildMCPTools(): Promise<{
  tools: Record<string, llm.FunctionTool<any>>;
  client: Client;
}> {
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
  Object.keys(properties).length === 0
    ? { _noop: z.string().optional() }  // dummy field so Zod accepts {}
    : Object.fromEntries(
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
          } else if (key === "sql" && typeof val === "string") {
      // Strip trailing semicolons — surveilr MCP doesn't accept them
      coerced[key] = val.trim().replace(/;+$/, "");
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
  private mcpClient: Client;

  constructor(
    instructions: string,
    tools: Record<string, llm.FunctionTool<any>>,
    client: Client
  ) {
    super({ instructions, tools });
    this.mcpClient = client;

    console.log("📝 Instructions length:", instructions.length);
    console.log("🔧 Tools registered:", Object.keys(tools).join(", "));
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions:
        "Greet the user warmly and naturally. Let them know you are connected to the surveilr database and ready to answer questions about their data. Do not mention tables, schemas, or technical details.",
    });
  }

  override async onExit(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
    }
  }
}