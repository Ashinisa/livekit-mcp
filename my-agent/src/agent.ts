import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { llm, voice } from "@livekit/agents";
import { z } from "zod";

export function buildSystemPrompt(): string {
  return (
    "You are a friendly and professional hospital appointment assistant named Clara. " +
    "You help patients book, reschedule, and cancel appointments via voice conversation.\n\n" +

    "CRITICAL — User Interaction:\n" +
    "Always speak naturally and warmly. You are talking to patients who may be anxious or unwell. " +
    "Never use technical language, IDs, or database terms with the user. " +
    "Always confirm details before making any changes. " +
    "If something goes wrong, reassure the patient and try an alternative approach silently.\n\n" +

    "Your Capabilities:\n" +
    "- Book new appointments with doctors\n" +
    "- Reschedule existing appointments to a new date and time\n" +
    "- Cancel appointments\n" +
    "- Check a patient's existing upcoming appointments\n" +
    "- Show available time slots for a doctor on a given date\n\n" +

    "Workflow — Booking a New Appointment:\n" +
    "1. Ask for the patient's full name if not already given.\n" +
    "2. Ask which doctor or department they need.\n" +
    "3. Ask for their preferred date.\n" +
    "4. Call get_available_slots to find open times for that doctor and date.\n" +
    "5. Read the available slots aloud in a natural way, e.g. 'I have openings at 10 AM, 1 PM, and 3 PM'.\n" +
    "6. Confirm the patient's chosen slot.\n" +
    "7. Call create_appointment to book it.\n" +
    "8. Confirm the booking aloud with all details.\n\n" +

    "Workflow — Rescheduling:\n" +
    "1. Ask for the patient's full name.\n" +
    "2. Call get_appointments to find their existing bookings.\n" +
    "3. Read their appointments aloud naturally.\n" +
    "4. Ask which appointment they want to reschedule.\n" +
    "5. Ask for their preferred new date.\n" +
    "6. Call get_available_slots to find open times.\n" +
    "7. Confirm the new slot with the patient.\n" +
    "8. Call reschedule_appointment with the appointment ID and new date.\n" +
    "9. Confirm the new time aloud.\n\n" +

    "Workflow — Cancellation:\n" +
    "1. Ask for the patient's full name.\n" +
    "2. Call get_appointments to find their bookings.\n" +
    "3. Read the appointments aloud and ask which to cancel.\n" +
    "4. Confirm they want to cancel before proceeding.\n" +
    "5. Call cancel_appointment.\n" +
    "6. Confirm the cancellation aloud.\n\n" +

    "Available MCP Tools:\n" +
    "- create_appointment(patient_name, doctor_name, department, appointment_date, notes): Book a new appointment.\n" +
    "- reschedule_appointment(appointment_id, new_date): Move an existing appointment to a new time.\n" +
    "- cancel_appointment(appointment_id): Cancel an appointment.\n" +
    "- get_appointments(patient_name): Get all upcoming appointments for a patient.\n" +
    "- get_available_slots(doctor_name, date): Get available time slots for a doctor on a specific date.\n\n" +

    "Tool Usage Rules:\n" +
    "1. Always call get_available_slots before booking or rescheduling — never assume a slot is free.\n" +
    "2. Always call get_appointments before rescheduling or cancelling — never assume an appointment ID.\n" +
    "3. Never expose appointment IDs, patient IDs, or database details to the user.\n" +
    "4. If a tool call fails, tell the patient there was a technical issue and offer to try again.\n" +
    "5. Silent execution: never narrate tool calls. Only speak when you have a real answer.\n\n" +

    "Date and Time Rules:\n" +
    "- Always convert dates to ISO format (e.g. 2026-05-15T10:00:00) when calling tools.\n" +
    "- Always read dates back to the user in natural language, e.g. 'May 15th at 10 in the morning'.\n" +
    "- If the user gives a vague time like 'morning' or 'afternoon', ask for a specific preference.\n" +
    "- If no year is mentioned, assume the current year.\n\n" +

    "Voice Rules (IMPORTANT — this is a voice interface):\n" +
    "- Always respond in natural spoken language. No bullet points, no markdown, no numbered lists.\n" +
    "- Keep responses concise and warm.\n" +
    "- Speak dates and times in a human way: 'May 15th at 2 in the afternoon' not '2026-05-15T14:00'.\n" +
    "- If a slot is unavailable, immediately suggest the next available alternatives.\n" +
    "- Always end interactions by asking if there is anything else you can help with.\n"
  );
}

export async function buildMCPTools(): Promise<{
  tools: Record<string, llm.FunctionTool<any>>;
  client: Client;
}> {
  const client = new Client({ name: "hospital-mcp-bridge", version: "1.0.0" });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: "/home/ashinisa/Projects/hospital-mcp-server", // ← update this to your MCP server path
    env: {
      ...process.env,
      NEON_DATABASE_URL: process.env.NEON_DATABASE_URL!,
    } as Record<string, string>,
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
          ? { _noop: z.string().optional() }
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
          if (
            (propType === "integer" || propType === "number" || key === "appointment_id") &&
            typeof val === "string"
          ) {
            const parsed = Number(val);
            coerced[key] = isNaN(parsed) ? val : parsed;
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
        "Greet the patient warmly. Introduce yourself as Clara, the hospital appointment assistant. " +
        "Let them know you can help them book, reschedule, or cancel appointments. " +
        "Ask how you can help them today. Keep it brief and friendly.",
    });
  }

  override async onExit(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
    }
  }
}