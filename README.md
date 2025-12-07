# I GAVE UP.





# BoltProxy

BoltProxy (v1) is my first attempt at making a web proxy. The source code is written in typescript (ts), however the runtime is written in javascript (js).
Unfortunately, due to my lack of knowledge for how web proxies work (and not wanting to use uv/scramjet).
The following don't work or are very buggy:
Post requests or websockets (i lowk don't know which one it is lmao)
GitHub (it starts spamming requests and crashes ur browser and I have no clue why but it has something to do with image loading)
Discord (this is what ive been testing everything on)
Any captcha (it will just load infinitely)
Cloudflare sites

## Prerequisites

- Node.js 18+
- npm 9+

Install dependencies once:

```bash
npm install
```

## Development Workflow

- **Edit TypeScript**: make changes only under `src/`.
- **Hot dev server**: run the TypeScript sources directly with ts-node.

```bash
npm run dev
```

The server runs on <http://localhost:8080>; static assets are served from `public/`.

For compiler feedback while you work, keep the watcher running:

```bash
npm run build:watch
```

## Production Build & Start

Compile everything to `dist/` (emits `dist/server.js` and `dist/rewriter.js`) and start Node from the compiled output:

```bash
npm run build
npm start
```

`npm start` automatically rebuilds first (`prestart` hook) so you can deploy confidently.

## Cleaning

If you need a fresh build, remove the `dist/` folder:

```bash
npm run clean
```

## Project Structure

```
├── public/          # Static client files (served as-is)
├── src/             # TypeScript sources (server + HTML/JS rewriter)
├── dist/            # Emitted JavaScript after running `npm run build`
├── tsconfig.json    # TypeScript compiler configuration
└── package.json
```
