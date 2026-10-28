import express from 'express';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, stat as statFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Prefetch on boot so we can verify S3 access in Render logs without user interaction.
getShort03().then(buf => console.log('ByteFuse short03 prefetch ready, bytes:',buf.length)).catch(err => console.error('ByteFuse short03 prefetch failed:',err.message));


/* Assemble the existing paid Liam voiceover into ByteFuse Lab Short 03.
   Uses the cached MP3; this does not invoke vidIQ generation or charge credits. */
const short03Video = {
  status:'waiting', path:null, bytes:null, error:null, promise:null
};
const short03Slides = [
  ['EMAIL TAKING TOO LONG?', ['Stop rewriting','the same email.']],
  ['THE CHATGPT TRICK', ['Make any message','sound professional.']],
  ['BEFORE', ['Hey Alex,','I need the report.','Send it today.']],
  ['COPY THIS PROMPT', ['Rewrite this email to sound','polite, clear, and professional.','Keep it short.',"Don't change the meaning."]],
  ['AFTER', ['Hi Alex, could you please','send me the report today?','Thanks so much for your help.']],
  ['SAME REQUEST', ['Better tone.','Clearer message.']],
  ['ONE MORE TRICK', ['Ask for a friendlier','or more direct version.']],
  ['BYTEFUSE LAB', ['Save this trick.','Follow for practical AI tips.']]
];
function xmlText(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function short03SVG(i) {
  const [head,lines] = short03Slides[i];
  const body = lines.map((line,j) =>
    '<text x="105" y="' + (660+j*108) +
    '" font-family="DejaVu Sans, Arial, sans-serif" font-weight="600" font-size="44" fill="#eff5ff">' +
    xmlText(line) + '</text>').join('\n');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">' +
    '<rect width="1080" height="1920" fill="#091223"/>' +
    '<rect x="65" y="100" width="950" height="1715" rx="48" fill="#112038" stroke="#20637b" stroke-width="4"/>' +
    '<text x="105" y="183" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="27" fill="#64e3eb">BYTEFUSE LAB  /  AI SHORTS</text>' +
    '<text x="105" y="408" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="54" fill="#5be0ea">' + xmlText(head) + '</text>' +
    body +
    '<text x="105" y="1710" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="27" fill="#8fabc1">BYTEFUSE LAB  |  ' +
    String(i+1).padStart(2,'0') + ' / 08</text></svg>';
}
async function assembleShort03() {
  if (short03Video.promise) return short03Video.promise;
  short03Video.promise = (async () => {
    short03Video.status='rendering';
    const audio = await getShort03();
    const dir = await mkdtemp(join(tmpdir(),'bytefuse03-'));
    const voicePath=join(dir,'voice.mp3');
    await writeFile(voicePath,audio);
    const ffprobe=spawnSync(ffmpegPath,['-hide_banner','-i',voicePath],{encoding:'utf8',timeout:12000});
    const match=(ffprobe.stderr||'').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration=match ? Number(match[1])*3600+Number(match[2])*60+Number(match[3]) : 38.844;
    const weights=[4.5,5.8,4.2,8.2,7.8,4.3,3.6,4.2];
    const total=weights.reduce((a,b)=>a+b,0);
    let manifest='ffconcat version 1.0\n';
    for(let i=0;i<short03Slides.length;i++){
      const filename=join(dir,'slide_'+String(i).padStart(2,'0')+'.png');
      await sharp(Buffer.from(short03SVG(i))).png().toFile(filename);
      manifest += "file '"+filename+"'\n";
      manifest += "duration "+(duration*weights[i]/total).toFixed(5)+"\n";
    }
    manifest += "file '"+join(dir,'slide_07.png')+"'\n";
    const manifestPath=join(dir,'slides.ffconcat');
    await writeFile(manifestPath,manifest);
    const output=join(dir,'ByteFuse_Lab_Short_03_FINAL.mp4');
    const args=['-y','-hide_banner','-loglevel','error','-safe','0','-f','concat',
      '-i',manifestPath,'-i',voicePath,'-vf','fps=24,format=yuv420p',
      '-c:v','libx264','-preset','ultrafast','-crf','24','-threads','2',
      '-c:a','aac','-b:a','128k','-af','loudnorm=I=-16:TP=-1.5:LRA=11',
      '-t',String(duration),'-movflags','+faststart',output];
    await new Promise((resolve,reject)=>{
      const proc=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
      let err='';
      proc.stderr.on('data',b=>{err=(err+b.toString()).slice(-2500)});
      proc.on('error',reject);
      proc.on('close',code=>code===0 ? resolve() : reject(new Error('ffmpeg exit '+code+': '+err)));
    });
    const stat=await statFile(output);
    if(stat.size<10000)throw new Error('Rendered MP4 unexpectedly small');
    short03Video.path=output;
    short03Video.bytes=stat.size;
    short03Video.status='ready';
    console.log('ByteFuse short03 video ready, bytes:',stat.size,'duration:',duration);
  })().catch(err=>{
    short03Video.status='failed';
    short03Video.error=err.message;
    console.error('ByteFuse short03 video failed:',err.message);
  });
  return short03Video.promise;
}
app.get('/vidiq-03-video-status', (_req,res) => {
  res.json({status:short03Video.status,bytes:short03Video.bytes,
    error:short03Video.error,format:'mp4',resolution:'1080x1920'});
});
app.get('/vidiq-03-final.mp4', async (req,res) => {
  const key=String(req.query.key??'');
  const expected=process.env.VIDIQ_SHORT03_TOKEN||'';
  const a=Buffer.from(key), b=Buffer.from(expected);
  if(expected.length<32 || a.length!==b.length || !timingSafeEqual(a,b))return deny(res);
  if(short03Video.status==='waiting')void assembleShort03();
  if(short03Video.status!=='ready')
    return res.status(503).json({status:short03Video.status,error:short03Video.error});
  return res.download(short03Video.path,'ByteFuse_Lab_Short_03_FINAL.mp4');
});
getShort03().then(()=>assembleShort03()).catch(err=>
  console.error('ByteFuse short03 video source unavailable:',err.message));
