# Setup and deployment

## Local preview

1. Install Node.js compatible with the Vite version in `package-lock.json`.
2. Run `npm ci` and copy `.dev.vars.example` to `.dev.vars`.
3. Supply your Supabase project URL and a publishable/anon key, never a service-role key.
4. Create an invited user's Supabase account and put its email in `TESTER_EMAILS`.
5. Supply your Anam API key and avatar, voice and LLM IDs. Add Tavus keys/IDs only if you need its fallback modes.
6. Run `npm run build`, then `npm run preview`. Open the localhost URL Wrangler prints.

The local `.dev.vars` file can override the blank identifiers and disabled call flag in `wrangler.jsonc`.

## Cloudflare

Use your own Cloudflare account and Worker name. Fill the non-secret avatar/voice/LLM IDs in `wrangler.jsonc`, keep conservative budget values, and leave calls disabled until the setup is complete. `ANAM_CREDIT_POOL_ID` is an application budget namespace, not an API credential. Optional poster URLs and Tavus IDs must belong to your own provider setup.

Set production secrets interactively:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put TESTER_EMAILS
npx wrangler secret put ANAM_API_KEY
```

For Tavus modes, also set `TAVUS_API_KEY`. `.dev.vars` is for local development; it is not uploaded automatically. Avoid putting API keys or invited-email lists in `wrangler.jsonc`.

Set the Supabase site URL and allowed redirect URLs for your chosen deployment. Enable `CALLS_ENABLED` only after configuring identity, allowlist, provider IDs and budgets. Run the checks below, then deploy with `npm run deploy`.

```bash
npm run typecheck
npm test
npm run build
```

## Manual verification

Check invited-user sign-in and rejection of other users, microphone permission, streamed audio/video, early hangup, reconnecting, recent-turn recall, all three languages, captions, mobile framing and depleted-budget behavior. These checks consume provider usage. Do not claim the deployment works solely because the code compiles.
