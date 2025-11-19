# BoltProxy

A teaching proxy that rewrites HTML/JS to route all network requests through a local Express server. The app is written in TypeScript so you always edit the sources in `src/` and let the compiler emit runnable JavaScript into `dist/`.

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

Happy hacking! 🎯
