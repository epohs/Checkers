# WebSocket Protocol

The contract between the vanilla-JS client and the TypeScript Durable Object. This document is the source of truth for the boundary (there are no shared type definitions), so implementation on either side follows it exactly.

All messages are JSON text frames, with one exception: the heartbeat frames `ping` and `pong` are raw text, not JSON (see Heartbeat below).

## Connection

The client opens a WebSocket to:

```
wss://<host>/g/<code>/ws
```

The URL is derived from `location` at runtime — the host is never configured or hardcoded.

The server bounds the socket set per game (64): past the cap it refuses new connections, evicting a hello-less socket first if one exists. Legitimate play never approaches this.

## Heartbeat

TCP dies silently on bad networks: a socket can look open while frames go nowhere. The client sends the raw text frame `ping` during quiet stretches (every ~20s); the server answers `pong` via the Durable Object's auto-response facility, which replies without waking a hibernated game. If nothing at all arrives for ~45s, the client closes the socket and reconnects with backoff. Reconnects also fire immediately on the browser's `online` event and when a hidden tab becomes visible again.

`ping` never reaches the message handler (auto-response intercepts it), so it is exempt from the "junk before hello closes the connection" rule.

## Log epoch

Every game log carries an **epoch** — an opaque string minted when the game first stores anything and wiped with everything else at expiry. It exists so delta sync (below) can tell "you're caught up" apart from "the log you knew was deleted": a client claiming events from a stale epoch always receives the full log.

## Events (the stored things)

An **event** is what lives in the append-only log. Three kinds:

```jsonc
{ "kind": "move", "path": [11, 15], "seat": "black" }          // simple move
{ "kind": "move", "path": [22, 15, 8], "seat": "red" }         // double jump: from, then each landing square
{ "kind": "resign", "seat": "red" }
{ "kind": "new_round" }
```

`path` lists squares in standard checkers notation (1–32, dark squares only — see [architecture.md](architecture.md#board-and-notation)): the starting square, then every square the piece lands on, in order. Captured squares are implied by the hops and never sent.

The server stamps `seat` on `move` and `resign` events from the seat of the sending socket; a client-supplied `seat` is ignored. `new_round` carries no seat.

## Client → server

### hello (required first message)

```jsonc
{ "type": "hello", "playerId": "<random id from localStorage>", "have": 12, "epoch": "<epoch from a previous welcome>", "context": "game" }
```

`playerId` must be a non-empty string of at most 64 characters (the client generates 16). The server assigns a seat (first unknown id → `black`, second → `red`, otherwise `spectator`) and replies with `welcome`. Any other message before `hello` — including an invalid `playerId` or an unparseable frame — closes the connection.

`context` is optional: `"game"` (the game page — the default) or `"landing"` (the landing page's turn-ring sockets). Landing sockets receive the log and drive the turn ring, but never count toward presence.

`have` and `epoch` are optional and drive delta sync: a reconnecting client claims it already holds `have` events from log generation `epoch`, and the `welcome` then carries only the suffix past that point. Absent, invalid, or stale claims (unknown epoch, `have` beyond the log's end) fall back to the full log — so a first-time client simply omits them.

### append

```jsonc
{ "type": "append", "index": 12, "event": { "kind": "move", "path": [22, 15, 6] } }
{ "type": "append", "index": 13, "event": { "kind": "resign" } }
{ "type": "append", "index": 14, "event": { "kind": "new_round" } }
```

`index` must equal the current log length. Structural checks, in order:

1. Sender has a seat (spectators cannot append) → else `rejected: "spectator"`.
2. `index` equals log length → else `rejected: "index_mismatch"`.
3. `event` is well-formed → else `rejected: "malformed"`. Well-formed means exactly one of:
   - `move` with `path` an array of **2–13** integers, each in **1–32**;
   - `resign`;
   - `new_round`.
4. The log is below its cap (20,000 events — unreachable in legitimate play; it only bounds abuse) → else `rejected: "log_full"`.

The server stores only the known fields (`kind`, `path`, and the stamped `seat`); anything else on the event is dropped. Whether a path is a *legal* move is not checked — that is a rule, and rules live in the client (see [architecture.md](architecture.md#the-event-log)).

On success the server appends, stamps the seat on `move` and `resign`, resets the expiry alarm, and broadcasts `appended` to **all** sockets including the sender. The sender treats its own `appended` broadcast as confirmation; it must not apply the event to its derived state before that. (A multi-jump being tapped out is UI preview, not applied state.)

### set_name

```jsonc
{ "type": "set_name", "name": "Grudge match" }
```

Renames the game. Accepted only from the `black` seat (the creator — black is the first seat assigned). The server trims the name and caps it at 16 characters, then claims it in the global name registry (a singleton Durable Object, uniqueness compared case-insensitively). If the name is already held by another live game, the registry grants a numbered variant instead — `"Pomme"` → `"Pomme 2"`, and when the suffix wouldn't fit in 16 characters the base gives way: `"Pomme's game Sun"` → `"Pomme's game Su2"`. **The granted name — variant or not — is what gets stored and broadcast**, so the namer sees the collision and can rename again. Renaming releases the game's previous name; a game's name is also retired when the game expires (90 days of silence), making it claimable again.

Anything invalid — wrong seat, non-string, empty after trimming — is ignored silently: the client shows the rename affordance only to black, so a rejection would have no one to inform.

### signal

```jsonc
{ "type": "signal", "name": "dismiss" }
```

A transient message relayed to every other socket in the game and stored nowhere. The server does not know what a signal means — this is fan-out and nothing else. It does not reset the expiry alarm.

Accepted from seated players only (`name` a string of at most 32 characters); anything else is ignored silently. The only name in use is `dismiss` — either player clearing the end-of-round celebration clears it for both of them and every spectator. A spectator's own dismissal is local and sends nothing.

## Server → client

### welcome (reply to hello)

```jsonc
{
  "type": "welcome",
  "seat": "black",                  // "black" | "red" | "spectator"
  "name": "Grudge match",           // string | null (never named); ≤16 chars
  "epoch": "<log generation id>",
  "from": 12,                       // index the log slice starts at
  "log": [ { "kind": "move", "path": [11, 15], "seat": "black" }, ... ],
  "presence": { "black": true, "red": false }
}
```

`log` holds the events from index `from` onward. When `from` is `0` the client replaces its local log wholesale; when `from > 0` (the delta case — it equals the `have` the client sent) the client keeps its first `from` events and appends the slice. The client stores `epoch` and echoes it in later `hello`/`resync` messages.

### appended (broadcast)

```jsonc
{ "type": "appended", "index": 12, "event": { "kind": "move", "path": [22, 15, 6], "seat": "red" } }
```

If `index` is exactly the client's local log length, append and update. If it is ahead (a gap), the client has missed events: send `resync`. If behind, it is a duplicate: ignore.

### rejected (reply to a failed append)

```jsonc
{ "type": "rejected", "reason": "index_mismatch", "expectedIndex": 14 }
```

`reason` is `"index_mismatch" | "spectator" | "malformed" | "log_full"`. On `index_mismatch` the client resyncs **only if `expectedIndex` differs from its local log length** — when the winning append's own broadcast already caught it up (the common race), a refetch would be wasted bytes — and then re-derives whether its intended action is still legal. The likeliest race is a resignation landing while the other player was mid-turn; the round is then over and the move is simply dropped. The other reasons need no special handling — the client just re-renders.

### name (broadcast after a successful set_name)

```jsonc
{ "type": "name", "name": "Grudge match 2" }
```

Carries the name the registry actually granted, which may differ from what `set_name` asked for. The client replaces its local name.

### presence (broadcast on connect/disconnect)

```jsonc
{ "type": "presence", "black": true, "red": false }
```

A seat is `true` while at least one **game-page** socket holding it is connected — landing-page turn-ring sockets never count. Clients close their socket while the tab is hidden, so presence means the player is actually looking at the game. Never stored. Broadcast after every `hello` (to everyone but the joiner, whose `welcome` already carries it) and when a **seated** game socket closes — a spectator, pre-hello, or landing socket leaving changes nothing, so nothing is sent.

### signal (relayed)

```jsonc
{ "type": "signal", "name": "dismiss" }
```

The relay of a client's `signal`, delivered to every socket in the game except the sender. Never stored, so a client joining later learns nothing about signals it missed — which is correct for `dismiss`, since the celebration it clears only ever fires live. Landing-page sockets receive these and ignore them under the forward-compatibility rule.

### resync request and reply

```jsonc
// client → server
{ "type": "resync", "have": 12, "epoch": "<epoch from welcome>" }
// server → client
{ "type": "log", "epoch": "<log generation id>", "from": 12, "log": [ ... ] }
```

`have`/`epoch` and `from` work exactly as in `hello`/`welcome`: a valid claim gets just the suffix, anything else gets the full log with `from: 0`. The client keeps at most one resync in flight.

## Ordering guarantees

- The log is totally ordered by the Durable Object's single-threaded execution; `index` is authoritative.
- Clients must tolerate duplicate and out-of-date broadcasts (refresh races); the index rules above make handling deterministic.
- An unknown `type` in either direction is ignored, not an error — this is the forward-compatibility rule.
