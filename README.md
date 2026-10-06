# Checkers

A minimal, two-player checkers game you play over a shared link — live or asynchronously.

Create a game, text the link to a friend, and take turns. Both of you at your screens? Moves appear instantly. One of you busy? Come back tonight; the game is exactly where you left it.

## How it works, in one paragraph

The client owns all game logic — move validation, captures, kinging, win and draw detection, score — and the server owns nothing but an append-only event log per game. Every device derives the entire game state by replaying that log. The server never learns the rules of checkers; it enforces only that appends arrive in order and come from the seat that owns them. See [docs/architecture.md](docs/architecture.md) for the full model and [docs/protocol.md](docs/protocol.md) for the wire contract.

## Stack

- **Frontend:** vanilla HTML, CSS, and JavaScript. No framework, no build step. The rules live in `public/rules.js`, a DOM-free module the page and the test suite both import.
- **Backend:** a Cloudflare Worker with two Durable Object classes (TypeScript) — `GameDO`, one instance per game holding that game's event log, and `NameRegistryDO`, a single global instance that keeps game names unique.
- **Transport:** native WebSockets.

## Playing

- American checkers: 8×8, mandatory captures, multi-jumps, kings move one square in any direction. The full rules are in [docs/architecture.md](docs/architecture.md#the-rules).
- Visiting the bare domain shows a minimal landing page: start a new game, or reopen a recent one (remembered in your browser's localStorage).
- A game lives at `/g/<code>`. The first browser to open a game gets the black seat, the second gets red, and anyone else watches as a spectator.
- Tap a piece, then tap where it goes. A multi-jump is tapped hop by hop.
- Whoever created the game can click its name in the header to rename it. Names are unique across all games; asking for one that's taken gets you a numbered variant.
- A round ends in a win, a resignation, or an automatic draw after 40 moves per side with no capture and no uncrowned piece moving. Either player can start a rematch once it's over; score accumulates for the life of the link.
- Games expire 90 days after the last activity.

## Local development

```sh
npm install
npm run dev      # wrangler dev
npm test         # node:test suite for the rules module
npm run check    # tsc --noEmit for the Worker
```

Then open the printed local URL. Seats are per-browser, so two windows of the same browser share one seat; use two different browsers (or a private window) to hold both.

To play both sides from one window, add `?hotseat` to a fresh game's URL (for example `/g/test1?hotseat`). The page opens a second connection that takes the other seat and sends each move as whichever side is to move. It only works on `localhost`/`127.0.0.1`, and only while the second seat is free.

## Deployment

```sh
npx wrangler deploy --dry-run   # bundle and check without uploading
npm run deploy                  # wrangler deploy
```

Route the Worker to your domain as a Custom Domain in Cloudflare. The client derives its WebSocket URL from `location`, so no domain is configured anywhere in the code. Setting the `CANONICAL_HOST` Worker secret makes the `workers.dev` host redirect there.

Deploys stay on Wrangler for now: `cf migrate` (beta) can't yet carry over the Durable Object storage migrations this project depends on.

## Docs

- [docs/architecture.md](docs/architecture.md) — the rules, the event-log model, seats, game names, derivation, presence, expiry
- [docs/protocol.md](docs/protocol.md) — WebSocket message schemas and the append contract
- [docs/design.md](docs/design.md) — layout, move input, last-move display, theming, animation

## License

[AGPL-3.0](LICENSE).
