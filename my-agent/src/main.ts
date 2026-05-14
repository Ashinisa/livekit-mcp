import { ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import * as google from '@livekit/agents-plugin-google';  // ← add this
// import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent, buildMCPTools, buildSystemPrompt } from './agent';
import 'dotenv/config';
import * as deepgram from '@livekit/agents-plugin-deepgram';
// import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';

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
    const instructions = buildSystemPrompt();
    console.log("📝 System prompt ready, length:", instructions.length);

    const session = new voice.AgentSession({
      // stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
      stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
      // llm: openai.LLM.withGroq({ model: 'llama-3.3-70b-versatile' }),
      llm: new google.LLM({ model: 'gemini-2.5-flash' }),
      tts: new cartesia.TTS({
  model: 'sonic-2',
  voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
}),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad,
      voiceOptions: { preemptiveGeneration: true },
    });

    await session.start({
      agent: new Agent(instructions, tools, client),
      room: ctx.room,
      // inputOptions: {
      //   noiseCancellation: audioEnhancement({ model: 'quailVfL' }),
      // },
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