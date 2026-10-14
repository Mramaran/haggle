# Haggle

Rehearse your freelance rate against a client who won't make it easy. The client is played by an open-weight model (Gemma 2 2B) running in your own browser tab, so there is no server, no API key, and nothing you type leaves your computer.

You quote a price. The client lowballs you, asks for a free trial, slips in extras or wants to pay in 90 days. You negotiate for up to eight turns. At the end you get a receipt: your score, the client's real limit, and the exact line where you gave money away for nothing.

Built for the DEV Hacktoberfest 2026 Open-Source AI Challenge, Week 2: Side Hustle.

## Play

Play it at **https://haggle.mrmaran.workers.dev/**

To run it locally:

```bash
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173).

- **Start negotiating** downloads the model the first time (about 1.4 GB, then cached by your browser). It needs a browser with WebGPU, such as a current Chrome or Edge, and a computer with a graphics card.
- **Play without the AI (no download)** runs anywhere: your moves are read by simple rules and the client answers with fixed lines.
- Add `?debug` to the address to see, after each reply, how the model read your line, whether a code rule overrode it, and whether the reply came from the model or a fixed line.

## How it works

The game splits the work so that a small model only does what it is good at.

| Part | Done by |
|---|---|
| The client's opening offer, each concession step, its real limit, and when the game ends | Code (`src/game.ts`) |
| The client's lines, in character | The model, checked by code; a reply that invents a number, breaks character or agrees when it shouldn't is retried once, then replaced by a fixed line (`src/llm.ts`) |
| Reading your move: holding firm, discounting, trading, walking away, accepting | The model, with code rules for cases it is known to get wrong (`resolveIntent` in `src/game.ts`) |
| The score | Code only: up to 60 points for how close the result is to the client's real limit, 40 for never giving ground without getting something back, minus 12 per unconditional concession (`src/score.ts`) |

The scorecard's share link carries the score and one quoted line in the link itself, so it opens on any device without loading the model.

The model library loads only when you start the AI client, so the page itself is about 9 KB compressed.

## What testing showed

Measured in the browser on one laptop with an NVIDIA RTX 40-series GPU. Full records are kept outside this repository with the project notes.

- **Smaller models failed.** Gemma 3 1B looped and invented amounts; Qwen 2.5 1.5B lost track of who was speaking. Gemma 2 2B made no invented amounts and no character breaks in 126 replies.
- **Four-round play-test on Gemma 2 2B:** offers matched the rules on 19 of 19 turns; the model wrote 21 of 23 replies on its first try; its reading of the player's move was kept on 15 of 19 turns, with code correcting the rest.
- **A bug the play-test caught:** "What's your real budget?" was read as a trade and made the client raise his offer. Questions are now settled before trades.
- **Known faults:** the model occasionally uses the wrong direction word ("bump it down" while raising), and sometimes repeats the player's figure as if it were its own.

## Tests

```bash
npm test         # unit tests for the game rules, intent rules and scoring
npm run e2e      # Playwright end-to-end tests of the version without the AI (uses Microsoft Edge)
```

`spike.html` is the page used to choose the model. `scripts/ai-playtest.mjs` plays the four test rounds, or one round through the game page, on the real model in headless Edge with the GPU:

```bash
node scripts/ai-playtest.mjs <edge profile folder>             # four rounds, results saved by the dev server
node scripts/ai-playtest.mjs <edge profile folder> <model> game  # one round through the game page
```

## Built with

- [Gemma 2 2B](https://ai.google.dev/gemma), run through [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU
- TypeScript and Vite, Vitest and Playwright

## Licences

The code in this repository is under the MIT licence (see `LICENSE`).

The model is not part of this repository. Your browser downloads Gemma 2 2B from its model hub when you start the AI client, and its use is governed by the [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
