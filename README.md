# Amelia's Talker

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
