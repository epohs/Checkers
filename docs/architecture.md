# Architecture

## Principles

1. **The client owns the game logic.** Move validation, captures, kinging, turn order, win and draw detection, and scorekeeping all happen in the browser. The server never knows the rules of checkers.
2. **The server owns the event log.** One append-only log per game is the single source of truth. Everything else — board, whose turn it is, score — is derived by replaying it.
3. **The server enforces structure, not rules.** Four checks on an append, none of them about checkers: the sender holds a seat, the index equals the current log length, the event is one of the three known shapes, and the log is under its abuse cap. The server also *stamps* the seat on a move or resignation from the sending socket rather than trusting the client's. Together these kill races, duplicates, and seat confusion without any game knowledge. The exact order and rejection reasons are in [protocol.md](protocol.md).
4. **Minimal in every direction.** No accounts, no matchmaking, no anti-cheat. This is a game between two people who trust each other.

## Topology

```
browser (black)   ─┐
browser (red)     ─┼── WebSocket ──▶ Cloudflare Worker ──▶ GameDO — one per game code
browser (watcher) ─┘
                                                             ├─ event log     (storage)
                                                             ├─ seat map      (storage)
                                                             ├─ game name     (storage)
                                                             ├─ log epoch     (storage)
                                                             └─ expiry alarm
                                                                   │
                                                                   │ RPC: claim / release
                                                                   ▼
                                                           NameRegistryDO — one, global
                                                             └─ name ⇄ code maps (storage)
```

- The Worker serves the static frontend and routes WebSocket upgrades on `/g/<code>/ws` to the Durable Object for that code. It also permanent-redirects the `*.workers.dev` host to the canonical domain, which is why assets are configured to run the Worker first.
- **`GameDO`** — one instance per game code. Its storage holds the event log, the seat assignments, the game's name, and a log epoch; its in-memory socket set provides broadcast and presence.
- **`NameRegistryDO`** — a single global instance (id `"global"`) that makes game names unique. `GameDO` calls it over RPC; see [Game names](#game-names).
- WebSocket hibernation keeps idle games costless.

## Game identity

- A game code is ~10 characters generated client-side with `crypto.getRandomValues` when the player starts a new game from the landing page.
- The game URL is `/g/<code>`. Any `/g/*` path serves the same single-page client (SPA fallback); the client reads the code from `location.pathname`.
- There is no game creation API. The first connection to a code brings its Durable Object into existence.

## Seats

- Each browser generates a random `playerId` once and keeps it in localStorage.
- On connect, the client presents its `playerId`. The Durable Object assigns seats first-come: first unknown id gets **black**, second gets **red**, everyone after is a **spectator** (read-only).
- A seat keeps its color for the life of the link. Colors never swap between rounds; the *starting* seat alternates instead (see [The rules](#the-rules)).
- Reconnecting with a known id returns the same seat, so a refresh or a dropped connection never flips your color. A seat belongs to a browser, not a device pool — opening the link in a different browser joins as whatever seat (or spectator role) is left.

## Game names

A game is identified by its code, but it can also carry a human name so the landing page's recent list reads as something other than ten random strings.

- Only **black** — the creator, being the first seat assigned — can set the name. The client shows the rename affordance to nobody else, so the server ignores anyone else silently rather than rejecting them.
- The name is stored in `GameDO` and broadcast to everyone at the game. It is not an event and never enters the log: it is current state, not history, and replaying a rename would mean nothing.
- Names are **globally unique**, case-insensitively, which is what `NameRegistryDO` exists for. It holds two mirrored maps — name → code and code → name — and its single-threaded execution is what makes claim-then-store race-free without any locking.
- A collision does not fail. The registry grants a numbered variant instead (`"Pomme"` → `"Pomme 2"`, and when the suffix wouldn't fit in the 16-character limit the base gives way: `"Pomme's game Sun"` → `"Pomme's game Su2"`), and the granted name is what gets stored and broadcast, so the namer can see what happened and try again.
- Renaming releases the game's previous name. Expiry releases it too, so a dead game does not hold a name hostage; if the registry is unreachable at that moment the name stays reserved, which is a nuisance and never worth blocking the deletion over.

## The rules

American checkers (English draughts). All of this lives in `public/rules.js`, a DOM-free module shared by the page and the `node:test` suite.

### Board and notation

- 8×8 board, play on the dark squares only. The dark squares are numbered **1–32** in standard checkers notation, and that numbering is what the log stores. It is never shown on screen.
- Squares 1–4 form black's back row; 29–32 form red's. Black starts on **1–12**, red on **21–32**; 13–20 start empty.
- Black men move toward 32 and crown on **29–32**. Red men move toward 1 and crown on **1–4**.

### Moving

- A **man** (uncrowned piece) moves one square diagonally forward. A **king** moves one square diagonally in any direction — no flying kings.
- A **capture** jumps an adjacent opposing piece diagonally to the empty square directly beyond it. Men capture forward only; kings capture in any direction.
- **Captures are mandatory.** If any capture is available to the side to move, a non-capturing move is illegal. When several captures are available, the player chooses which — there is no requirement to take the longest.
- **Multi-jumps are mandatory.** Once a piece captures, it must keep capturing with that same piece while a further capture is available from its landing square. A turn ends only when no continuation remains.
- **Crowning ends the turn.** A man that reaches its crowning row becomes a king and the turn stops there, even if the new king could capture further.
- Captured pieces leave the board as they are jumped, so a piece can never be jumped twice in one turn.

### Ending a round

- **Win:** the side to move has no pieces, or no legal move. The other side wins.
- **Resign:** either seat may resign at any time while the round is in progress, including during the opponent's turn. The other side wins.
- **Auto-draw:** a round is drawn once **40 moves per side** (80 consecutive turns) pass with no capture and no man moving. Any capture or any man moving resets the count. Draws score nothing.
- Within a round, seats alternate. **Black starts round 1; the starting seat alternates each round** (red starts round 2, and so on), regardless of who won.
- Score is the count of rounds each seat has won across the whole log. There is no other score storage anywhere.

## The event log

The log holds exactly three event kinds:

- `move` — a whole turn as a path of squares (`[from, to]` for a simple move, `[from, land, land, …]` for a jump), stamped by the server with the seat that sent it. A turn is appended only once its path is complete; a half-finished multi-jump never reaches the log.
- `resign` — ends the current round, stamped by the server with the seat that sent it.
- `new_round` — a round boundary, starting a fresh board.

Rules for deriving state from the log (all client-side):

- The board is replayed from the last `new_round` (or the log start), applying the rules above.
- The client only *offers* moves that are legal and complete, offers Resign only while the round is in progress, and offers Rematch only once it is over — but these are client rules. The server accepts any structurally valid append.
- Derivation is where the rules live, so it is also where impossible history gets filtered: replay **shrugs off** any event the rules can't produce — a move out of turn, a move whose path is not a legal and *complete* turn (a missed mandatory capture, a jump that stops while a continuation exists, a jump that continues past crowning), anything after the round ended other than `new_round`, and a `new_round` before the round is over. A hostile or buggy client can pollute the log with such events, but every honest client derives the same clean game past them.

## Synchronization

- On connect, the Durable Object sends your seat plus the log — in full for a first join, or just the suffix past what the client already holds (delta sync, guarded by a per-log **epoch** so a client from an expired game's previous life can't mistake an empty delta for "caught up"). See [protocol.md](protocol.md).
- Live events broadcast to all connected sockets in the game; each client appends to its local copy and updates incrementally.
- If your opponent is offline, your move still lands in the log — they replay it whenever they return. This is what makes asynchronous play work.
- The append-index contract means a client that has fallen behind gets its append rejected with the expected index; it re-syncs and re-derives whether its intended action is still legal. See [protocol.md](protocol.md).

Not everything that travels between clients is history. Three kinds of message cross the wire, and only the first is stored:

| | Stored | Ordered by index | Survives a reconnect |
| --- | --- | --- | --- |
| **Events** (`move`, `resign`, `new_round`) | yes, in the log | yes | yes — replayed from the log |
| **State** (game name, presence) | name yes, presence no | no | name yes, presence recomputed |
| **Signals** (`dismiss`) | no | no | no |

A **signal** is transient coordination relayed to everyone else at the game and kept nowhere. The server does not know what one means; it is fan-out and nothing else. Signals stay clear of the log on purpose: a dismissal is not something a later replay should reproduce, it carries no index, and two arriving at once cannot collide the way two appends would. The only one in use is `dismiss`, which is how either player clearing the end-of-round celebration clears it for both of them and every spectator.

Resignation is deliberately an event and not a signal: it changes the score, so it must survive replay.

## Surviving bad connections

The design assumes phones on flaky networks:

- **Heartbeat:** the client pings over quiet stretches; the Durable Object's auto-response answers without waking a hibernated game. A long silence means the socket is dead even though it looks open — the client closes it and reconnects.
- **Reconnect:** exponential backoff with jitter, capped low (~10s) because an attempt is one cheap request and iOS doesn't reliably fire wake events. Short-circuited by every wake signal the browser offers — `online`, `focus`, `pageshow`, a tab becoming visible — and by tapping the board while disconnected. A connection attempt stuck in `CONNECTING` is abandoned after 10s.
- **In-flight appends:** an append whose confirmation never arrives triggers a resync after a few seconds rather than leaving the board frozen.
- **Mid-turn drops cost nothing:** a multi-jump being tapped out is local UI state until its path is complete, so losing the connection halfway through loses nothing that was ever sent.
- **Bandwidth:** reconnects fetch only the log suffix (delta sync above); static assets carry cache headers so fonts and icons are never re-downloaded, and HTML/JS/CSS revalidate as cheap 304s.

## Presence

Presence answers one question: is the other player at the game right now? It is computed, never stored — a seat is present while at least one socket holding it is open on the game screen, so the socket set *is* the presence state and there is nothing to keep in sync.

- Broadcast when a socket says hello and when a **seated** game socket closes. A spectator or pre-hello socket leaving changes nothing, so nothing is sent.
- **Being at the game is the definition.** Hiding the tab closes the socket, which marks you away exactly as if you had clicked Leave; returning reconnects and marks you back. This is why the reconnect logic refuses to open a socket while the tab is hidden.
- The landing page's turn-ring sockets say `context: "landing"` in their hello and never count toward presence: watching a ring on the landing page is not being at the game.
- Never written to the log, and a reconnect recomputes it from scratch. See [protocol.md](protocol.md).

## Persistence and expiry

- Durable Object storage is the only server-side persistence: each `GameDO` (log, seats, name, epoch) plus the one `NameRegistryDO` (the name maps).
- localStorage (keys prefixed `checkers:`) holds only the browser's `playerId`, its theme preference, and the landing page's recent-games list — for each game, its code, your seat, the name if it has one, whether the current round has finished, and when you last played it. All of it is convenience; none of it is authoritative, and clearing it loses your seat but not any game.
- Every connection, append, or rename resets a `GameDO` alarm 90 days out. Signals do not. When the alarm fires the game's storage is deleted and its name released; the link then behaves as a brand-new empty game, with a fresh epoch so stale clients full-sync rather than mistaking an empty delta for "caught up".

## Testing

- The rules module is built test-first against a committed `node:test` suite (`npm test`, no dependencies). It covers at minimum: forced capture, choosing between captures, a branching multi-jump, crowning ending a jump, king captures in every direction, no-legal-move loss, the 40-move draw and its reset, resignation, starter alternation, and replay shrugging off each kind of impossible event.
- The Worker is checked with `tsc --noEmit` and a throwaway WebSocket script against `wrangler dev`; the UI is checked in Safari at the sizes in [design.md](design.md).

## Accepted tradeoffs

- No server-side rule enforcement, by design. A hostile client can still bloat the log with impossible events (up to the abuse cap), but honest clients filter them out during derivation, so the worst it achieves is wasted bytes.
- No cross-browser identity: your seat is tied to one browser's localStorage. Clearing site data forfeits the seat (the game itself survives on the server).
- No draw offers. A two-step offer/accept across async time would need pending state, withdrawal, and expiry; the 40-move rule ends stalemated endgames, and resignation ends hopeless ones.
- Two players and spectators only; no lobbies, no discovery.
