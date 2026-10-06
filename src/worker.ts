/**
 * Checkers — Cloudflare Worker entry point.
 *
 * The Worker routes WebSocket upgrades on /g/<code>/ws to the Durable
 * Object for that game code; every other request falls through to the
 * static assets (with SPA fallback configured in wrangler.jsonc).
 *
 * GameDO is the per-game Durable Object: append-only event log, seat
 * map, presence, expiry alarm. Protocol contract: docs/protocol.md.
 * The server validates structure only — it knows nothing of the rules
 * of checkers.
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  GAME: DurableObjectNamespace;
  NAMES: DurableObjectNamespace<NameRegistryDO>;
  ASSETS: Fetcher;
  // Secret (never in the repo): the domain the site canonically lives on.
  // When set, requests to the *.workers.dev host redirect there.
  CANONICAL_HOST?: string;
}

const WS_PATH = /^\/g\/([A-Za-z0-9_-]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The workers.dev host is not canonical: permanent-redirect it to
    // the real domain (requires run_worker_first so assets don't answer
    // before we can).
    if (env.CANONICAL_HOST && url.hostname.endsWith(".workers.dev")) {
      const target = new URL(url);
      target.protocol = "https:";
      target.hostname = env.CANONICAL_HOST;
      target.port = "";
      return Response.redirect(target.toString(), 301);
    }

    const match = url.pathname.match(WS_PATH);

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const code = match[1]!;
      const stub = env.GAME.get(env.GAME.idFromName(code));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Seat = "black" | "red" | "spectator";
type Player = Exclude<Seat, "spectator">;

type GameEvent =
  | { kind: "move"; path: number[]; seat?: Player }
  | { kind: "resign"; seat?: Player }
  | { kind: "new_round" };

/** Per-socket state, kept in the hibernation-safe attachment. */
interface Attachment {
  playerId: string;
  seat: Seat;
  /** Where the socket lives: the game page counts for presence; the
      landing page's turn-ring sockets do not. */
  context: "game" | "landing";
}

const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Longest playerId accepted in hello; the client generates 16 chars.
// Bounds the seat map and keeps the socket attachment under its 2KB limit.
const MAX_PLAYER_ID = 64;

// Longest game name, in characters after trimming. Uniqueness suffixes
// ("Pomme 2") must also fit within this. Enforced here; the client's
// rename input caps itself to match, via its own MAX_NAME in
// public/app.js — change one and change the other.
const MAX_NAME = 16;

// Log cap: a legitimate game never approaches this (tens of thousands of turns),
// but it keeps a hostile client from growing the stored log until the
// storage write fails. Past it, appends are rejected with "log_full".
const MAX_LOG = 20000;

// Longest signal name relayed between clients. Signals are transient
// UI coordination, never stored — the cap just keeps the relay small.
const MAX_SIGNAL = 32;

// Socket cap: a legitimate game never has more than a handful of
// sockets (two players across a few tabs, a couple of spectators, the
// landing page's turn-rings). Past this we evict or refuse, so a
// hostile client can't pile up connections against a game.
const MAX_SOCKETS = 64;

export class GameDO {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // Heartbeat: clients send a raw "ping" text frame; the runtime answers
    // "pong" itself, so a hibernated game is never woken by keepalives.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    // Remember our own code (a DO can't recover the name behind its id);
    // the name registry keys claims by it.
    const code = new URL(request.url).pathname.split("/")[2];
    if (code && !(await this.state.storage.get("code"))) {
      await this.state.storage.put("code", code);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation API: the runtime holds the socket and wakes us per
    // message, so idle games cost nothing. No attachment until hello.
    this.state.acceptWebSocket(server);

    // Keep the socket set bounded: past the cap, evict a socket that
    // hasn't sent hello yet (the cheapest to lose); if there is none,
    // refuse the newcomer. Its close handler broadcasts nothing — a
    // hello-less socket holds no seat.
    const sockets = this.state.getWebSockets();
    if (sockets.length > MAX_SOCKETS) {
      const idle = sockets.find((s) => s !== server && s.deserializeAttachment() === null);
      if (idle) idle.close(1013, "too many connections");
      else server.close(1013, "too many connections");
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;

    let msg: any = null;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      // fall through with msg = null
    }
    if (typeof msg !== "object" || msg === null) {
      // Post-hello, tolerate junk frames; pre-hello, anything that isn't
      // a valid hello closes the connection (protocol.md).
      if (!attachment) ws.close(1008, "hello required");
      return;
    }

    // hello is the required first message; anything else first closes.
    if (!attachment) {
      if (
        msg.type === "hello" &&
        typeof msg.playerId === "string" &&
        msg.playerId !== "" &&
        msg.playerId.length <= MAX_PLAYER_ID
      ) {
        await this.handleHello(ws, msg);
      } else {
        ws.close(1008, "hello required");
      }
      return;
    }

    switch (msg.type) {
      case "append":
        await this.handleAppend(ws, attachment, msg);
        break;
      case "resync":
        send(ws, { type: "log", ...(await this.logSlice(msg)) });
        break;
      case "set_name":
        await this.handleSetName(attachment, msg);
        break;
      case "signal":
        this.handleSignal(ws, attachment, msg);
        break;
      default:
        break; // unknown types are ignored — forward-compatibility rule
    }
  }

  // The closing socket can still appear in getWebSockets() while these
  // handlers run, so it is excluded from the presence computation. Only a
  // seated socket's departure changes presence; spectator and pre-hello
  // closes would broadcast a no-op frame to everyone.
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.presenceMayHaveChanged(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.presenceMayHaveChanged(ws);
  }

  private presenceMayHaveChanged(closing: WebSocket): void {
    const a = closing.deserializeAttachment() as Attachment | null;
    if (a && a.seat !== "spectator" && a.context !== "landing") {
      this.broadcast({ type: "presence", ...this.presence(closing) });
    }
  }

  /** Expiry: fire means 90 days of silence — delete the game. */
  async alarm(): Promise<void> {
    // Retire the game's name so it becomes claimable again.
    const code = await this.state.storage.get<string>("code");
    if (code) {
      try {
        await this.registry().release(code);
      } catch {
        // registry unreachable: the name stays reserved — a nuisance,
        // never worth blocking the deletion over
      }
    }
    await this.state.storage.deleteAll();
  }

  private registry(): DurableObjectStub<NameRegistryDO> {
    return this.env.NAMES.get(this.env.NAMES.idFromName("global"));
  }

  private async handleHello(ws: WebSocket, msg: any): Promise<void> {
    const playerId: string = msg.playerId;
    const seats = (await this.state.storage.get<Record<string, Seat>>("seats")) ?? {};

    let seat = seats[playerId];
    if (!seat) {
      const taken = new Set(Object.values(seats));
      seat = !taken.has("black") ? "black" : !taken.has("red") ? "red" : "spectator";
      if (seat !== "spectator") {
        seats[playerId] = seat;
        await this.state.storage.put("seats", seats);
      }
    }

    ws.serializeAttachment({
      playerId,
      seat,
      context: msg.context === "landing" ? "landing" : "game",
    } satisfies Attachment);
    await this.resetExpiry();

    send(ws, {
      type: "welcome",
      seat,
      name: (await this.state.storage.get<string>("name")) ?? null,
      ...(await this.logSlice(msg)),
      presence: this.presence(),
    });
    // The joiner already has presence from welcome; tell everyone else.
    this.broadcast({ type: "presence", ...this.presence() }, ws);
  }

  /**
   * Delta sync: a client that claims `have` events from epoch `epoch`
   * gets only the suffix past what it holds (`from` marks the join
   * point). Anything off — unknown epoch (the log was reset by expiry),
   * a claim past the log's end, or an old client sending neither field —
   * falls back to the full log with from: 0.
   */
  private async logSlice(msg: any): Promise<{ epoch: string; from: number; log: GameEvent[] }> {
    const log = await this.getLog();
    const epoch = await this.getEpoch();
    const from =
      msg.epoch === epoch &&
      Number.isInteger(msg.have) &&
      msg.have >= 0 &&
      msg.have <= log.length
        ? msg.have
        : 0;
    return { epoch, from, log: from > 0 ? log.slice(from) : log };
  }

  /**
   * The log's generation marker. Expiry's deleteAll wipes it, so a
   * reborn game mints a fresh epoch and stale clients full-sync instead
   * of mistaking an empty slice for "already caught up".
   */
  private async getEpoch(): Promise<string> {
    let epoch = await this.state.storage.get<string>("epoch");
    if (!epoch) {
      epoch = crypto.randomUUID();
      await this.state.storage.put("epoch", epoch);
    }
    return epoch;
  }

  private async handleAppend(ws: WebSocket, attachment: Attachment, msg: any): Promise<void> {
    // Structural checks, in protocol order: spectator, index, shape.
    if (attachment.seat === "spectator") {
      send(ws, { type: "rejected", reason: "spectator" });
      return;
    }

    const log = await this.getLog();
    if (msg.index !== log.length) {
      send(ws, { type: "rejected", reason: "index_mismatch", expectedIndex: log.length });
      return;
    }

    const event = wellFormed(msg.event);
    if (!event) {
      send(ws, { type: "rejected", reason: "malformed" });
      return;
    }

    if (log.length >= MAX_LOG) {
      send(ws, { type: "rejected", reason: "log_full" });
      return;
    }

    // The server stamps the seat; whatever the client sent is ignored.
    if (event.kind !== "new_round") event.seat = attachment.seat;

    log.push(event);
    await this.state.storage.put("log", log);
    await this.resetExpiry();

    this.broadcast({ type: "appended", index: log.length - 1, event });
  }

  /**
   * Rename the game. Creator-only (black is the first seat assigned) and
   * silently ignored otherwise — the client never shows the edit
   * affordance to anyone else, so a rejection has no one to inform.
   *
   * Names are globally unique: the registry may return a variant
   * ("Pomme 2") of what was asked for, and the variant is what gets
   * stored and broadcast, so the namer sees the collision happened.
   */
  private async handleSetName(attachment: Attachment, msg: any): Promise<void> {
    if (attachment.seat !== "black") return;
    if (typeof msg.name !== "string") return;
    const wanted = msg.name.trim().slice(0, MAX_NAME).trimEnd();
    if (!wanted) return;

    const code = (await this.state.storage.get<string>("code")) ?? "";
    if (!code) return;
    const name = await this.registry().claim(wanted, code);

    await this.state.storage.put("name", name);
    await this.resetExpiry();
    this.broadcast({ type: "name", name });
  }

  /**
   * Relay a transient signal to everyone else in the game. The server
   * neither stores it nor knows what it means — this is fan-out and
   * nothing else, which is why it stays clear of the event log: a
   * signal is not game history, it carries no index, and two of them
   * arriving at once can't race the way two appends would.
   *
   * Seated players only. A spectator clearing their own screen is
   * their business, not everyone's, and the expiry alarm is left alone
   * — signals are not the kind of activity that should keep a game
   * alive for another 90 days.
   */
  private handleSignal(ws: WebSocket, attachment: Attachment, msg: any): void {
    if (attachment.seat === "spectator") return;
    if (typeof msg.name !== "string" || msg.name.length > MAX_SIGNAL) return;
    this.broadcast({ type: "signal", name: msg.name }, ws);
  }

  private async getLog(): Promise<GameEvent[]> {
    return (await this.state.storage.get<GameEvent[]>("log")) ?? [];
  }

  private async resetExpiry(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + EXPIRY_MS);
  }

  /** A seat is present while at least one game-page socket holds it.
      Landing-page turn-ring sockets (context "landing") never count —
      presence means being on the game screen. */
  private presence(except?: WebSocket): Record<Player, boolean> {
    const present = { black: false, red: false };
    for (const socket of this.state.getWebSockets()) {
      if (socket === except) continue;
      const a = socket.deserializeAttachment() as Attachment | null;
      if (a && a.seat !== "spectator" && a.context !== "landing") {
        present[a.seat] = true;
      }
    }
    return present;
  }

  private broadcast(msg: unknown, skip?: WebSocket): void {
    const frame = JSON.stringify(msg);
    for (const socket of this.state.getWebSockets()) {
      if (socket === skip) continue;
      try {
        socket.send(frame);
      } catch {
        // a socket mid-close is not our problem; close events handle presence
      }
    }
  }
}

/**
 * NameRegistryDO — the single global registry of game names (one
 * instance, id "global"). Uniqueness is case-insensitive; the display
 * casing is whatever the claimer typed. Storage is two mirrored maps:
 *   name:<lowercased name> → code    (who holds this name)
 *   code:<code>            → lowercased name (what this game holds)
 * Claims are called over RPC from GameDO, and the DO's single-threaded
 * execution is what makes claim-then-store race-free.
 */
export class NameRegistryDO extends DurableObject {
  /**
   * Claim `base` (pre-trimmed, ≤ MAX_NAME chars) for game `code`,
   * returning the name actually granted. On collision, numbered
   * variants: "Pomme" → "Pomme 2", and when the suffix wouldn't fit,
   * the base gives way — "Pomme's game Sun" → "Pomme's game Su2".
   * Re-claiming a name the game already holds is a no-op; claiming a
   * new one releases its old name.
   */
  async claim(base: string, code: string): Promise<string> {
    const storage = this.ctx.storage;

    let candidate = base;
    for (let n = 2; ; n++) {
      const owner = await storage.get<string>("name:" + candidate.toLowerCase());
      if (!owner || owner === code) break;
      const num = String(n);
      candidate =
        base.length + 1 + num.length <= MAX_NAME
          ? base + " " + num
          : base.slice(0, MAX_NAME - num.length).trimEnd() + num;
    }

    const previous = await storage.get<string>("code:" + code);
    if (previous && previous !== candidate.toLowerCase()) {
      await storage.delete("name:" + previous);
    }
    await storage.put("name:" + candidate.toLowerCase(), code);
    await storage.put("code:" + code, candidate.toLowerCase());
    return candidate;
  }

  /** Retire whatever name the game holds (expiry calls this). */
  async release(code: string): Promise<void> {
    const storage = this.ctx.storage;
    const held = await storage.get<string>("code:" + code);
    if (held) await storage.delete("name:" + held);
    await storage.delete("code:" + code);
  }
}

// A move's path: the starting square plus every landing, in 1–32
// notation. 13 squares covers the longest jump sequence the board allows
// (a piece can take at most 12), so anything longer is malformed.
const MIN_PATH = 2;
const MAX_PATH = 13;

/**
 * Returns a fresh copy of the event if structurally valid, else null.
 * Only known fields survive. Whether a path is a legal move is a rule,
 * and rules live in the client.
 */
function wellFormed(event: any): GameEvent | null {
  if (typeof event !== "object" || event === null) return null;
  if (event.kind === "new_round") return { kind: "new_round" };
  if (event.kind === "resign") return { kind: "resign" };
  if (
    event.kind === "move" &&
    Array.isArray(event.path) &&
    event.path.length >= MIN_PATH &&
    event.path.length <= MAX_PATH &&
    event.path.every((square: unknown) => Number.isInteger(square) && (square as number) >= 1 && (square as number) <= 32)
  ) {
    return { kind: "move", path: [...event.path] };
  }
  return null;
}

function send(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closed; nothing to do
  }
}
