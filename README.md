# ByteFuse Voice

A private Gemini 3.8 Flash TTS service for ChatGPT MCP.

## Required Render environment variables

- `GEMINI_API_KEY` — Gemini key, set only in the Render dashboard. **Never commit it to GitHub.**
- `BYTEFUSE_PLUGIN_TOKEN` — a separately generated random secret of 24+ characters. Set in Render and enter the same value into ChatGPT when connecting the plugin. Never commit it to GitHub.
- `PUBLIC_BASE_URL` — Render service URL, e.g. `https://bytefuse-voice.onrender.com` (optional).

## Deploy

1. Create a GitHub repository and upload `server.js`, `package.json` and `README.md` without secrets.
2. Render → New Web Service, plan Free, runtime Node, build `npm install`, start `npm start`.
3. Set both secrets under Render service Environment and deploy.
4. Check `https://YOUR-SERVICE.onrender.com/health` — shows whether credentials are configured, never their values.
5. Create a private ChatGPT plugin with `mcp.json` pointing at `https://YOUR-SERVICE.onrender.com/mcp`, with API key auth header `X-ByteFuse-Token`.
6. Test `voice_status`, then `generate_voice`. Audio download links are temporary and should be retrieved promptly.

The service exposes no web page and no plaintext secrets. The Gemini key is used only server-side.

## Limitations

- Render Free web services spin down after inactivity, causing cold starts.
- Audio files are held temporarily in RAM; restarting the service loses them.
- Gemini free-tier availability, content usage and rate limits are set by Google.
- This API generates audio only, not videos. A separate editor composes MP4s.
- Keep requests within the provider's terms and your Gemini project's limits.
