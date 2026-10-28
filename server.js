import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.set('trust proxy', 1); // Respect Render HTTPS reverse proxy for temporary audio download links.
app.disable('x-powered-by');
app.use(express.json({ limit: '40kb' }));
const PORT = Number(process.env.PORT ?? 10000);
const BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || null;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.8-flash-tts';
const MAX_CHARS = 2000;
const AUDIO_TTL_MS = 45 * 60 * 1000;
const audioCache = new Map();

function validToken(candidate) {
  const expected = process.env.BYTEFUSE_PLUGIN_TOKEN || '';
  if (!candidate || !expected || expected.length < 24) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res) { return res.status(401).json({ error: 'unauthorized' }); }
function purgeAudio() {
  const now = Date.now();
  for (const [id, item] of audioCache) if (item.expiresAt < now) audioCache.delete(id);
}
function absoluteUrl(req, path) {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${origin}${path}`;
}

app.get('/health', (_req, res) => res.json({
  service: 'bytefuse-voice',
  status: 'online',
  geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  pluginTokenConfigured: Boolean(process.env.BYTEFUSE_PLUGIN_TOKEN),
}));

app.get('/audio/:id.wav', (req, res) => {
  purgeAudio();
  const item = audioCache.get(req.params.id);
  if (!item) return res.status(404).json({error:'audio_not_found_or_expired'});
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Disposition': 'attachment; filename="ByteFuse_voice.wav"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.send(item.audio);
});

function createServer(req) {
  const mcp = new McpServer({ name: 'bytefuse-voice', version: '0.1.0' });
  mcp.registerTool('voice_status', {
    description: 'Check whether Gemini TTS is configured without spending API quota.',
    inputSchema: {},
  }, async () => ({content:[{type:'text',text:JSON.stringify({
    connected: true,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    model: MODEL,
    maxCharacters: MAX_CHARS,
  })}]}));

  mcp.registerTool('generate_voice', {
    description: 'Create a private English voiceover using Gemini TTS. Returns a temporary WAV download link for editing into an MP4. Requests use the owner\'s Gemini free quota when available.',
    inputSchema: {
      text: z.string().min(1).max(MAX_CHARS).describe('Exact English words to narrate'),
      voice: z.enum(['Charon','Puck','Fenrir','Orus','Iapetus','Kore']).default('Charon'),
      style: z.string().max(250).default('Natural engaging American English narrator for YouTube Shorts. Confident, clear and lively, not robotic.'),
    },
  }, async ({text,voice,style}) => {
    const googleKey = process.env.GEMINI_API_KEY;
    if (!googleKey) return {isError:true,content:[{type:'text',text:'Gemini is not configured. Add GEMINI_API_KEY as a secret in Render dashboard.'}]};
    const payload = {
      model: MODEL,
      input: [{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style}]}]}],
      response_format: {type:'audio'},
      generation_config: {speech_config:[{voice}]},
    };
    let response;
    try {
      response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: {'x-goog-api-key': googleKey,'Content-Type':'application/json'},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(100000),
      });
    } catch (err) {
      return {isError:true,content:[{type:'text',text:`Gemini network error: ${err.message}`}]};
    }
    if (!response.ok) {
      const detail = await response.text();
      const clean = detail.slice(0,800).replaceAll(googleKey,'[REDACTED]');
      return {isError:true,content:[{type:'text',text:`Gemini returned HTTP ${response.status}: ${clean}`}]};
    }
    const result = await response.json();
   const base64 = (result.steps ?? [])
  .filter(step => step.type === 'model_output')
  .flatMap(step => step.content ?? [])
  .filter(part => part.type === 'audio' && typeof part.data === 'string')
  .at(-1)?.data ?? result.output_audio?.data;
    if (!base64) return {isError:true,content:[{type:'text',text:'Gemini response did not contain an audio block.'}]};
    const buffer = Buffer.from(base64,'base64');
    if (buffer.length > 18_000_000 || buffer.subarray(0,4).toString() !== 'RIFF') {
      return {isError:true,content:[{type:'text',text:'Gemini returned unexpected audio bytes (expected WAV).'}]};
    }
    purgeAudio();
    const id = randomBytes(24).toString('hex');
    audioCache.set(id,{audio:buffer,expiresAt:Date.now()+AUDIO_TTL_MS});
    const url = absoluteUrl(req, `/audio/${id}.wav`);
    return {content:[{type:'text',text:JSON.stringify({
      audioUrl:url,format:'wav',bytes:buffer.length,voice,model:MODEL,
      expiresInMinutes:45,
      note:'Download this WAV soon; audio is temporarily stored in memory.'
    })}]};
  });
  return mcp;
}

app.post('/mcp', async (req,res) => {
  if (!validToken(req.get('X-ByteFuse-Token'))) return deny(res);
  const mcp = createServer(req);
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req,res,req.body);
  } catch (err) {
    console.error('MCP request failed:',err?.message ?? 'unknown');
    if (!res.headersSent) res.status(500).json({error:'mcp_request_failed'});
  } finally {
    await transport.close().catch(()=>{});
    await mcp.close().catch(()=>{});
  }
});
app.get('/mcp', (_req,res)=>res.status(405).json({error:'post_only'}));
app.delete('/mcp', (_req,res)=>res.status(405).json({error:'stateless_only'}));


/* ByteFuse Short 03: retrieve existing paid vidIQ narration without re-generating it.
   The signed S3 URL is stored only in Render's environment, not in Git history. */
let short03Buffer = null;
async function getShort03() {
  if (short03Buffer) return short03Buffer;
  const url = process.env.VIDIQ_SHORT03_URL;
  if (!url) throw new Error('vidiq_audio_url_not_configured');
  const target = new URL(url);
  if (target.hostname !== 'ai-voiceovers.s3.us-east-1.amazonaws.com' ||
      target.pathname !== '/8733ba47-390c-4c2a-aac4-b2eddc7b6f58/e4abe642-02ee-4bdf-aa16-9438b6467a5d.mp3') {
    throw new Error('vidiq_audio_url_not_allowed');
  }
  const upstream = await fetch(url, {signal: AbortSignal.timeout(20000)});
  if (!upstream.ok) {
    const error = (await upstream.text()).slice(0,700).replace(/<[^>]+>/g,' ');
    throw new Error('vidiq_s3_http_' + upstream.status + ': ' + error);
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > 10_000_000 ||
      !(bytes.subarray(0,3).toString() === 'ID3' || bytes[0] === 0xff)) {
    throw new Error('vidiq_audio_not_mp3');
  }
  short03Buffer = bytes;
  return bytes;
}
app.get('/vidiq-03-status', async (_req,res) => {
  try {
    const audio = await getShort03();
    return res.json({status:'ready',bytes:audio.length,format:'mp3'});
  } catch (error) {
    return res.status(502).json({status:'upstream_error',reason:error.message});
  }
});
app.get('/vidiq-03.mp3', async (req,res) => {
  const key = String(req.query.key ?? '');
  const expected = process.env.VIDIQ_SHORT03_TOKEN || '';
  const a = Buffer.from(key); const b = Buffer.from(expected);
  if (expected.length < 32 || a.length !== b.length || !timingSafeEqual(a,b)) return deny(res);
  try {
    const audio = await getShort03();
    res.set({
      'Content-Type':'audio/mpeg',
      'Content-Disposition':'attachment; filename="ByteFuse_Lab_Short_03_Liam.mp3"',
      'Content-Length':String(audio.length),
      'Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff'
    });
    return res.send(audio);
  } catch (error) {
    return res.status(502).json({error:'vidiq_audio_unavailable',reason:error.message});
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`ByteFuse Voice listening on ${PORT}`));
