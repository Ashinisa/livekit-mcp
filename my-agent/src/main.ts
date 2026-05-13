import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import * as google from '@livekit/agents-plugin-google';  // ← add this
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent, buildMCPTools, getKnownTables, buildSystemPrompt } from './agent';
import 'dotenv/config';
// import * as openai from '@livekit/agents-plugin-openai';

dotenv.config({ path: '.env.local' });

interface ProcessUserData {
  vad: silero.VAD;
}

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    console.log("🔌 Connecting to MCP server (surveilr)...");
    const { tools, client } = await buildMCPTools();

    const toolNames = Object.keys(tools);
    console.log(`✅ MCP connected! Found ${toolNames.length} tools:`);
    toolNames.forEach((name) => console.log(`   - ${name}`));

    const knownTables = await getKnownTables(tools);
    console.log(`📊 Known tables: ${knownTables.length}`);

    const tableHint = knownTables.length
      ? `\n\nAvailable tables and views in the RSSD (use exact names):\n${knownTables.join(", ")}.`
      : "";

    const instructions = buildSystemPrompt(tableHint);
    console.log("📝 System prompt ready, length:", instructions.length);

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
      // llm: openai.LLM.withGroq({ model: 'llama-3.3-70b-versatile' }),
      llm: new google.LLM({ model: 'gemini-2.5-flash' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad,
      voiceOptions: { preemptiveGeneration: true },
    });

    await session.start({
      agent: new Agent(instructions, tools, client),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: audioEnhancement({ model: 'quailVfL' }),
      },
    });

    await ctx.connect();
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);