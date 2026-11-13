# My Turn

First built as Amelia's Talker.

A picture talker (AAC) that listens to people talking to the child and turns her tap into a full sentence. It grows with her in stages.

## Run
```
npm start
```
Serves `public/` on `PORT` (default 3000). No dependencies. Health check: `/health`.

## Deploy on Railway
New Project -> Deploy from GitHub repo -> pick this repo. No variables needed.

## Layout
- `server.js` static server
- `public/index.html` the whole app (words, sentence engine, settings)
- `public/sw.js` offline cache; `public/manifest.webmanifest` install info

## Cloud listening (iPad and Android)
Set one variable in Railway and redeploy:
- `ASSEMBLYAI_API_KEY` = your AssemblyAI key

To try Whisper on the same AssemblyAI key: add `STT_MODEL=whisper-rt` (costs about double).

To try Deepgram instead: set `STT_PROVIDER=deepgram` and `DEEPGRAM_API_KEY`.
With no key set, the app falls back to Chrome's built-in listening (Android/desktop Chrome only).

The key never reaches the tablet. The tablet asks `/api/stt/token` for a 60-second token and connects to the speech service itself.
It only connects while it hears a voice and hangs up after 20 quiet seconds.

## Photo scenes (AI word suggestions)
Photo scenes work with no extra setup: add words to a photo by hand.
To have the app suggest words from a photo, add `ANTHROPIC_API_KEY` in Railway. Optional: `VISION_MODEL` (default `claude-haiku-5-5`).
The photo is sent to Anthropic only when a grown-up presses "Suggest words".

## Child voices (optional)

Girl and boy voices come from Amazon Polly. Add these in Railway > Variables:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (an IAM user allowed only `polly:SynthesizeSpeech`)
- `AWS_REGION` (optional, default `us-east-1`)

Then pick Girl (Ivy), Boy (Kevin) or Boy (Justin) in Settings > Voice. The tablet saves every picture word and every
one- or two-picture sentence the first time, so they play instantly and offline. Check the keys at `/api/voice/selftest`.
