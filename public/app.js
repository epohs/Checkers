/*
 * The page: the connection layer both pages share, the landing page,
 * the game page, and the end-of-round celebration. The rules live in
 * rules.js; everything about the game is derived by replaying the log
 * through them. The server knows none of it — see docs/architecture.md.
 */

import {
  coords,
  squareAt,
  between,
  isJump,
  legalMoves,
  nextSquares,
  applyMove,
  otherSeat,
  derive,
  drawIn,
} from "./rules.js";

const PLAYERS = ["black", "red"];
const isPlayer = (seat) => PLAYERS.includes(seat);

// Local testing: a game opened with ?hotseat on localhost plays both
// sides from one browser. Never active on a deployed host.
const HOTSEAT =
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  new URLSearchParams(location.search).has("hotseat");

/* ================================================================
 * Connection layer — the tuning and the two pieces both pages share.
 * The game page and the landing page's turn-rings open different
 * sockets for different reasons, but they die the same way and they
 * resynchronize the same way.
 * ================================================================ */

// Heartbeat: ping over quiet stretches, and treat a long silence as a
// dead socket even though it still reads OPEN.
const HEARTBEAT_MS = 20000;
const SILENCE_MS = 45000;
// A socket can sit in CONNECTING for the browser's whole TCP timeout on
// a bad network; give up sooner so the retry path takes over.
const CONNECT_TIMEOUT_MS = 10000;
// Grace on waking, so a stale timestamp from a suspended tab doesn't
// kill a live socket before its pong has had time to land.
const WAKE_GRACE_MS = 25000;

// Game-page reconnect. The cap is low because an attempt is one cheap
// request and iOS doesn't reliably fire `online` — the timer is the
// recovery path there.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
// Turn-ring reconnect. Lower stakes and one socket per in-progress
// game, so it backs off much further before giving the server another
// round of attempts.
const RING_RETRY_MIN_MS = 5000;
const RING_RETRY_MAX_MS = 60000;
// Close code 1013 is the server shedding load (its per-game socket
// cap). Come back, but not soon enough to re-apply the pressure.
const OVERLOADED_RETRY_MS = 60000;

// An append whose confirmation never lands: ask for the log rather than
// leaving the board frozen.
const APPEND_TIMEOUT_MS = 8000;
// How many games the landing page remembers.
const RECENT_LIMIT = 10;
// Row fade before a removed game leaves the list. Must match the
// transition on #recent-list li in style.css.
const ROW_FADE_MS = 200;
// Longest game name. Must match MAX_NAME in src/worker.ts, which is
// what actually enforces it — this only stops the input accepting
// characters the server would silently drop.
const MAX_NAME = 16;

/**
 * Fold a welcome/log payload into a local event log and return the
 * result. Delta sync: the server sends only the events past what the
 * client's hello/resync claimed to hold, and `from` marks that join
 * point. `from: 0` — an epoch mismatch, or a log reset by expiry —
 * replaces wholesale. Pure; the caller owns where the log lives, and
 * the epoch alongside it.
 */
function mergeLog(log, msg) {
  const events = Array.isArray(msg.log) ? msg.log : [];
  const from = Number.isInteger(msg.from) ? msg.from : 0;
  return from > 0 && from <= log.length ? log.slice(0, from).concat(events) : events;
}

/**
 * Keep sockets honest over quiet stretches. TCP dies silently on flaky
 * networks — the socket still reads OPEN while frames go nowhere — so
 * ping periodically, and close anything that has heard nothing for
 * SILENCE_MS so the caller's normal reconnect path takes over. The
 * server answers pings from the Durable Object's auto-response, so a
 * hibernated game is never woken by a keepalive.
 *
 * `sockets` is called each tick and yields whatever should be checked
 * now, as objects carrying the socket and when it last heard anything.
 * Called rather than captured because both callers replace their
 * sockets over the life of the page.
 */
function startHeartbeat(sockets) {
  setInterval(() => {
    for (const { socket, lastAlive } of sockets()) {
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      if (Date.now() - lastAlive > SILENCE_MS) socket.close();
      else socket.send("ping");
    }
  }, HEARTBEAT_MS);
}

/** The ws:// or wss:// URL for a game code, derived from `location`. */
function socketUrl(code) {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  return scheme + location.host + "/g/" + code + "/ws";
}


/* ================================================================
 * Board motion and play. Restrained: a move slides, a capture pops,
 * a crown arrives — see "Animation" in docs/design.md.
 * ================================================================ */

// A slide, per hop, and the beat on each landing between hops so a
// double jump reads as two jumps.
const HOP_MS = 170;
const HOP_PAUSE_MS = 70;
const HOP_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
// The capture pop: a quick swell, then shrink away to nothing. Starts
// the moment the jumper passes over the piece.
const POP_MS = 280;
const POP_PEAK = 0.32; // share of the pop spent swelling
const POP_SWELL = 1.2;
const POP_SHRINK = 0.8;
// Pieces fading back in after a mid-jump rewind.
const RESTORE_MS = 160;
// How long an armed Resign waits for its confirming second tap.
const RESIGN_ARM_MS = 3000;
// The 40-move draw shows a countdown once this few moves per side remain.
const DRAW_WARNING = 10;
// Keyboard focus steps across the dark squares as the board is shown.
const ARROWS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/** The king's crown, drawn in the piece's contrast color. */
function crownNode() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "crown");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M2.5 7.5 7.5 12 12 4l4.5 8 5-4.5L19.5 19h-15z");
  svg.append(path);
  return svg;
}

function main() {
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode etc.; the game still works, identity just won't stick */
      }
    },
  };

  // The Worker's ws route matches [A-Za-z0-9_-]+; generate from a subset
  // with the ambiguous characters (0/O, 1/l/I) dropped.
  const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function randomCode(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let out = "";
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
  }

  function playerId() {
    let id = store.get("checkers:playerId", null);
    if (!id) {
      id = randomCode(16);
      store.set("checkers:playerId", id);
    }
    return id;
  }

  /* ---------------- theme ---------------- */

  const root = document.documentElement;
  const themeToggle = $("theme-toggle");
  const storedTheme = store.get("checkers:theme", null);
  if (storedTheme === "light" || storedTheme === "dark") root.dataset.theme = storedTheme;

  function isDark() {
    if (root.dataset.theme) return root.dataset.theme === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function paintToggle() {
    themeToggle.textContent = isDark() ? "☼" : "☾"; // ☼ / ☾
  }
  themeToggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    store.set("checkers:theme", next);
    paintToggle();
  });
  // With no manual override the glyph tracks the system scheme.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintToggle);
  paintToggle();

  /* ---------------- helpers ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---------------- routing ---------------- */

  const match = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/);
  if (match) initGame(match[1]);
  else initLanding();

  /* ---------------- landing ---------------- */

  function initLanding() {
    $("landing").hidden = false;
    $("new-game").addEventListener("click", () => {
      location.href = "/g/" + randomCode(10);
    });

    const recent = store.get("checkers:recent", []);
    if (!Array.isArray(recent) || recent.length === 0) return;
    $("recent").hidden = false;
    const list = $("recent-list");

    // Per-game live state, keyed by code, for in-progress games where the
    // local player holds a seat. Keeps a light WebSocket open per game so
    // the turn ring can react the moment the opponent moves.
    const live = new Map();

    for (const game of recent) {
      if (typeof game.code !== "string" || !/^[A-Za-z0-9_-]+$/.test(game.code)) continue;
      const item = el("li");
      const remove = el("button", "remove", "×");
      remove.title = "Remove";
      remove.setAttribute(
        "aria-label",
        "Remove " + (game.name || game.code) + " from recent games",
      );
      remove.addEventListener("click", () => removeRecent(game.code, item));
      item.append(remove);
      const link = el("a");
      link.href = "/g/" + game.code;
      const seatClass = isPlayer(game.seat) ? game.seat : "spectator";
      const chip = el("span", "chip " + seatClass);
      link.append(chip);
      // A named game shows its name; unnamed ones fall back to the code.
      if (typeof game.name === "string" && game.name) {
        link.append(el("span", "recent-name", game.name));
      } else {
        link.append(el("code", "recent-name", game.code));
      }
      if (game.done === false) link.append(el("span", "badge", "in progress"));
      link.append(
        el(
          "time",
          null,
          Number.isFinite(game.last) ? new Date(game.last).toLocaleDateString() : "",
        ),
      );
      item.append(link);
      list.append(item);

      // Live turn-ring: only in-progress player games are worth a socket.
      // These hello with context "landing", so they drive the ring but
      // never count toward presence — leaving a game makes you away.
      if (game.done === false && isPlayer(game.seat)) {
        live.set(game.code, {
          code: game.code,
          chip,
          seat: game.seat, // provisional; the server welcome is authoritative
          log: [],
          socket: null,
        });
      }
    }

    // The ring shows when it's the seated player's turn in a live round.
    function applyRing(entry) {
      const state = derive(entry.log);
      const myTurn =
        !state.over && state.turn === entry.seat && isPlayer(entry.seat);
      entry.chip.classList.toggle("you", myTurn);
    }

    function connectLanding(entry) {
      // Same rule as the game page: a hidden tab needs no sockets; the
      // visibilitychange handler reconnects when it becomes visible.
      if (document.hidden) return;
      const socket = new WebSocket(socketUrl(entry.code));
      entry.socket = socket;
      // A bad network can leave a socket stuck CONNECTING for a long
      // time; give up so the close handler schedules the retry.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        entry.backoff = RING_RETRY_MIN_MS;
        entry.lastAlive = Date.now();
        socket.send(
          JSON.stringify({
            type: "hello",
            playerId: playerId(),
            have: entry.log.length,
            epoch: entry.epoch,
            context: "landing",
          }),
        );
      });
      socket.addEventListener("message", (e) => {
        entry.lastAlive = Date.now();
        if (e.data === "pong") return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "welcome":
            if (typeof msg.epoch === "string") entry.epoch = msg.epoch;
            if (isPlayer(msg.seat)) entry.seat = msg.seat;
            entry.log = mergeLog(entry.log, msg);
            applyRing(entry);
            break;
          case "appended":
            if (msg.index === entry.log.length) {
              entry.log.push(msg.event);
              applyRing(entry);
            } else if (msg.index > entry.log.length) {
              entry.socket.send(
                JSON.stringify({
                  type: "resync",
                  have: entry.log.length,
                  epoch: entry.epoch,
                }),
              );
            }
            break;
          case "log":
            if (typeof msg.epoch === "string") entry.epoch = msg.epoch;
            entry.log = mergeLog(entry.log, msg);
            applyRing(entry);
            break;
          default:
            break;
        }
      });
      socket.addEventListener("close", (e) => {
        clearTimeout(connectTimeout);
        // The ring is derived exclusively from the event log by
        // applyRing() — never set directly by lifecycle events, so a
        // transient disconnect (DO restart, network blip) can't make
        // it flicker. If the game state actually changed while we
        // were offline, the next welcome/log will correct it.
        // Don't resurrect games the user removed from the list.
        if (live.has(entry.code)) {
          // Exponential backoff, so a downed server isn't hammered once
          // per in-progress game every few seconds.
          const backoff = entry.backoff ?? RING_RETRY_MIN_MS;
          const delay = e.code === 1013 ? OVERLOADED_RETRY_MS : backoff;
          entry.backoff = Math.min(backoff * 2, RING_RETRY_MAX_MS);
          setTimeout(() => {
            // Never stack a second socket onto a live one: the retry
            // only fires after this socket closed, but the visibility
            // handler may have already reconnected in the meantime.
            if (
              live.has(entry.code) &&
              (!entry.socket || entry.socket.readyState === WebSocket.CLOSED)
            ) {
              connectLanding(entry);
            }
          }, delay);
        }
      });
    }

    // Entries already carry `socket` and `lastAlive`, so they are what
    // the shared heartbeat wants to see.
    startHeartbeat(() => live.values());

    // A hidden tab's turn-rings are invisible, so its sockets are not
    // needed: close them, and reconnect everything on return. Mirrors
    // the game page's presence rule.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        for (const entry of live.values()) {
          if (entry.socket && entry.socket.readyState <= WebSocket.OPEN) entry.socket.close();
        }
        return;
      }
      for (const entry of live.values()) {
        // A fresh signal the network may be back: retry promptly rather
        // than inheriting a long delay from earlier trouble.
        entry.backoff = RING_RETRY_MIN_MS;
        if (!entry.socket || entry.socket.readyState === WebSocket.CLOSED) connectLanding(entry);
      }
    });

    for (const entry of live.values()) connectLanding(entry);

    /*
     * Removing a recent game. Briefly fade the row out, then drop it
     * from the DOM and delete its entry from the shared recent list in
     * local storage. The click can't reach the link (it's a separate
     * button), so navigation won't be triggered by a remove. The live
     * socket is also closed so it stops reporting presence.
     */
    function removeRecent(code, item) {
      const entry = live.get(code);
      if (entry && entry.socket) entry.socket.close();
      live.delete(code);
      item.classList.add("removing");
      const done = () => {
        item.remove();
        const stored = store.get("checkers:recent", []);
        const updated = (Array.isArray(stored) ? stored : []).filter(
          (g) => g && g.code !== code,
        );
        store.set("checkers:recent", updated);
        if (updated.length === 0) $("recent").hidden = true;
      };
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
      else setTimeout(done, ROW_FADE_MS);
    }
  }

  /* ---------------- game ---------------- */

  function initGame(code) {
    $("game").hidden = false;

    const boardEl = $("board");
    const nameEl = $("game-name");
    const statusEl = $("status");
    const scoreEl = $("score");
    const shareBtn = $("share");
    const resignBtn = $("resign");
    const rematchBtn = $("rematch");

    let ws = null;
    let connected = false;
    let seat = null; // "black" | "red" | "spectator" | null before welcome
    let gameName = null; // server-stored name; the code stands in until set
    let queuedName = null; // rename typed while offline; sent on next welcome
    let log = [];
    let epoch = null; // log generation from the server; guards delta sync
    // The derived state, memoized on the log's identity and length: the
    // log only ever grows by push or is replaced wholesale by mergeLog,
    // so those two are enough to know the replay is current. A tap or
    // an arriving event otherwise replays the whole log several times.
    let derived = { log: null, length: -1, state: null };
    let presence = { black: false, red: false };
    let pending = false; // an append is in flight; wait for its broadcast
    let pendingStamp = 0;
    let resyncing = false; // a resync is in flight; don't ask again
    let backoff = RETRY_MIN_MS;
    let reconnectTimer = null;
    let lastAlive = Date.now(); // last time any frame arrived on the socket

    // Hot seat (local testing only, see HOTSEAT): a second socket holding
    // the other seat — { socket, seat, lastAlive } — and the seat of the
    // append in flight, so its broadcast is recognized as our own.
    let partner = null;
    let pendingSeat = null;

    // The move being tapped out: the selected piece's square, then each
    // landing so far. Local preview only — nothing is sent until the
    // path is a complete move.
    let selection = null;
    // The square holding keyboard focus, kept across re-renders.
    let focusSquare = null;

    // When the hop just tapped finishes animating. Our own move comes
    // back from the server mid-hop, and rebuilding the board then would
    // cut the slide and its pop short.
    let boardSettlesAt = 0;
    let boardTimer = null;

    let resignArmed = false;
    let resignTimer = null;

    // Clearing the moment clears it for everyone at this game — either
    // player can do it, for both of them and every spectator. A
    // spectator's own click only clears their screen; a signal relayed
    // back would just bounce around the room.
    const celebration = createCelebration(boardEl, () => {
      if (isPlayer(seat)) send({ type: "signal", name: "dismiss" });
    });
    let celebratedRound = null; // the round whose ending we've already played
    let celebrateTimer = null;

    // Iterating on the celebration otherwise means two browsers and a
    // full game per attempt. From the console: checkersCelebrate("win"),
    // ("loss"), ("resign") or ("draw"). Local only — sends no signal.
    window.checkersCelebrate = (kind) => celebration.play(CELEBRATIONS[kind] || CELEBRATIONS.win);

    connect();
    render();

    function connect() {
      // A hidden tab is a player who isn't looking at the game: don't
      // connect (or reconnect) until the tab is visible again — the
      // visibilitychange handler reconnects on return.
      if (document.hidden) return;
      const socket = new WebSocket(socketUrl(code));
      ws = socket;
      // A bad network can leave a socket stuck CONNECTING for a long
      // time; give up so the close handler schedules the retry.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        backoff = RETRY_MIN_MS;
        lastAlive = Date.now();
        send({ type: "hello", playerId: playerId(), have: log.length, epoch });
      });
      socket.addEventListener("message", (e) => {
        lastAlive = Date.now();
        if (e.data === "pong") return; // heartbeat reply, not JSON
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        handle(msg);
      });
      socket.addEventListener("close", () => {
        clearTimeout(connectTimeout);
        if (ws !== socket) return; // superseded by a newer connection
        connected = false;
        pending = false;
        resyncing = false;
        selection = null;
        presence = { black: false, red: false };
        render();
        // Jittered, so two clients dropped by the same outage don't
        // come back in lockstep.
        reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random()));
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      });
    }

    // Read at each tick rather than captured: `ws` is replaced on every
    // reconnect, and `lastAlive` moves with every frame.
    startHeartbeat(() => [{ socket: ws, lastAlive }, ...(partner ? [partner] : [])]);

    /*
     * Hot seat: open a second socket under a second identity so it takes
     * the other seat, then send each move through whichever socket holds
     * the side to move. The server is none the wiser — it stamps every
     * move from the socket that sent it, as always. Every broadcast also
     * reaches the main socket, so the partner only needs its seat, and
     * to hear when one of its own appends is rejected.
     */
    function openPartner() {
      if (!HOTSEAT || document.hidden) return;
      if (partner && partner.socket.readyState <= WebSocket.OPEN) return;
      const socket = new WebSocket(socketUrl(code));
      const own = { socket, seat: null, lastAlive: Date.now() };
      partner = own;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", playerId: playerId() + "-hotseat" }));
      });
      socket.addEventListener("message", (e) => {
        own.lastAlive = Date.now();
        if (e.data === "pong") return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          own.seat = msg.seat;
          render();
        } else if (msg.type === "rejected") {
          handle(msg);
        }
      });
      socket.addEventListener("close", () => {
        own.seat = null;
      });
    }

    /** Whether this page is playing both sides right now. */
    function hotseatActive() {
      return !!partner && isPlayer(partner.seat) && isPlayer(seat);
    }

    // The instant the network returns or the tab wakes, don't sit out
    // the backoff timer — and probe a socket that may have died while
    // the tab was suspended.
    function reconnectNow() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastAlive = Math.max(lastAlive, Date.now() - WAKE_GRACE_MS);
        ws.send("ping");
        return;
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        backoff = RETRY_MIN_MS; // attempt underway; if it's stale, retry fast
        return;
      }
      clearTimeout(reconnectTimer);
      backoff = RETRY_MIN_MS;
      connect();
    }
    // Belt and suspenders: iOS fires these inconsistently (Control
    // Center doesn't even hide the page), so hook every wake signal —
    // reconnectNow is idempotent, duplicates are harmless.
    addEventListener("online", reconnectNow);
    addEventListener("focus", reconnectNow);
    addEventListener("pageshow", reconnectNow);
    document.addEventListener("visibilitychange", () => {
      // Hiding the tab (switching tabs/apps, minimizing) means the
      // player isn't at the game: close the socket so the server marks
      // them away, exactly like clicking Leave. Returning reconnects.
      if (document.hidden) {
        if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
        if (partner && partner.socket.readyState <= WebSocket.OPEN) partner.socket.close();
        return;
      }
      reconnectNow();
    });

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    /** The game as derived from the log right now. */
    function current() {
      if (derived.log !== log || derived.length !== log.length) {
        derived = { log, length: log.length, state: derive(log) };
      }
      return derived.state;
    }

    function requestResync() {
      if (resyncing) return;
      resyncing = true;
      send({ type: "resync", have: log.length, epoch });
    }

    /** Apply a welcome/log payload, epoch included. See mergeLog(). */
    function applyLog(msg) {
      if (typeof msg.epoch === "string") epoch = msg.epoch;
      log = mergeLog(log, msg);
    }

    function handle(msg) {
      switch (msg.type) {
        case "welcome":
          connected = true;
          seat = msg.seat;
          gameName = typeof msg.name === "string" ? msg.name : null;
          applyLog(msg);
          presence = {
            black: !!(msg.presence && msg.presence.black),
            red: !!(msg.presence && msg.presence.red),
          };
          pending = false;
          resyncing = false;
          selection = null;
          if (queuedName) {
            send({ type: "set_name", name: queuedName });
            queuedName = null;
          }
          rememberRecent();
          render();
          openPartner();
          break;
        case "name":
          if (typeof msg.name === "string") {
            gameName = msg.name;
            rememberRecent();
            renderName();
          }
          break;
        case "appended":
          if (msg.index === log.length) {
            // Our own move already played out hop by hop as it was
            // tapped; anything else that just arrived slides in.
            const mine = pending && msg.event && msg.event.seat === pendingSeat;
            log.push(msg.event);
            pending = false;
            selection = null;
            rememberRecent();
            render({ live: true, slide: !mine && msg.event.kind === "move" ? msg.event : null });
          } else if (msg.index > log.length) {
            requestResync(); // we missed events
          } // behind: duplicate, ignore
          break;
        case "log":
          applyLog(msg);
          pending = false;
          resyncing = false;
          selection = null;
          rememberRecent();
          render();
          break;
        case "rejected":
          pending = false;
          selection = null;
          // Resync only if actually behind — when the winning append's
          // broadcast already caught us up, a refetch is wasted bytes.
          if (msg.reason === "index_mismatch" && msg.expectedIndex !== log.length) {
            requestResync();
          }
          render();
          break;
        case "presence": {
          // Presence touches the HUD only: rebuilding the board here
          // would cut short a move that's mid-slide.
          presence = { black: !!msg.black, red: !!msg.red };
          const state = current();
          renderScore(state);
          renderStatus(state);
          break;
        }
        case "signal":
          // Someone at this game cleared the end-of-round moment.
          if (msg.name === "dismiss") clearCelebration();
          break;
        default:
          break; // unknown types are ignored — forward-compatibility rule
      }
    }

    // Called from the handlers that change what's worth remembering
    // (welcome/appended/log/name), not from render — a presence blip
    // shouldn't cost a localStorage write.
    function rememberRecent() {
      if (!seat) return;
      const state = current();
      const stored = store.get("checkers:recent", []);
      const recent = (Array.isArray(stored) ? stored : []).filter(
        (g) => g && g.code !== code,
      );
      recent.unshift({
        code,
        seat,
        name: gameName,
        done: !!state.over, // current round finished — unfinished games get flagged
        last: Date.now(),
      });
      store.set("checkers:recent", recent.slice(0, RECENT_LIMIT));
    }

    /**
     * Send an event for the next log index. Returns whether it went:
     * one append at a time, and only while connected. The caller
     * re-renders — a hop that completes a move is mid-animation, and a
     * full render here would cut it short.
     */
    function tryAppend(event, as = seat) {
      if (pending || !connected) return false;
      const frame = { type: "append", index: log.length, event };
      if (as === seat) send(frame);
      else if (partner && partner.seat === as && partner.socket.readyState === WebSocket.OPEN) {
        partner.socket.send(JSON.stringify(frame));
      } else return false;
      pending = true;
      pendingSeat = as;
      // If neither the broadcast nor a rejection ever lands, don't stay
      // frozen — ask for the log; its reply clears `pending` either way.
      const stamp = ++pendingStamp;
      setTimeout(() => {
        if (pending && pendingStamp === stamp) requestResync();
      }, APPEND_TIMEOUT_MS);
      return true;
    }

    /** The seat this page moves for right now, or null: its own seat, or
        in hot seat whichever side is to move. */
    function actingSeat(state) {
      if (!connected || pending || state.over) return null;
      if (isPlayer(seat) && state.turn === seat) return seat;
      if (hotseatActive() && partner.seat === state.turn) return partner.seat;
      return null;
    }

    /* ---------- making a move ---------- */

    /*
     * A tap (or Enter/Space) on a dark square. Select a movable piece,
     * then tap each landing in turn; the move is sent the moment its
     * path is complete. See "Making a move" in docs/design.md.
     */
    function tap(square) {
      const state = current();
      const mover = actingSeat(state);
      if (!mover) return;
      const moves = legalMoves(state.board, mover);
      const movable = nextSquares(moves, []);

      if (!selection) {
        if (movable.includes(square)) select([square]);
        return;
      }
      if (nextSquares(moves, selection).includes(square)) {
        hop(state, moves, square);
        return;
      }
      if (square === selection[0]) {
        cancelSelection();
        return;
      }
      // Before the first hop, another movable piece switches the
      // selection; anything else lets go. Mid-jump, the piece is
      // committed to finishing, so stray taps do nothing.
      if (selection.length === 1) select(movable.includes(square) ? [square] : null);
    }

    function select(path) {
      selection = path;
      renderBoard(current());
    }

    function hop(state, moves, square) {
      const from = selection[selection.length - 1];
      selection = [...selection, square];
      const preview = applyMove(state.board, selection);
      const complete = nextSquares(moves, selection).length === 0;
      if (complete) tryAppend({ kind: "move", path: selection }, actingSeat(state));
      const motion = renderBoard(state, {
        path: [from, square],
        captured: isJump(from, square) ? preview.captured.slice(-1) : [],
        crowned: complete && preview.crowned,
      });
      boardSettlesAt = performance.now() + motion;
      renderActions(state);
    }

    /** Escape, or a tap on the starting square: rewind, then let go. */
    function cancelSelection() {
      if (!selection || pending) return;
      if (selection.length > 1) {
        // Mid-jump: rewind to the start, and the popped pieces fade
        // back in. Nothing was sent, so it costs nothing.
        const state = current();
        const restored = applyMove(state.board, selection).captured.map((c) => c.square);
        selection = [selection[0]];
        renderBoard(state, null, restored);
      } else {
        select(null);
      }
    }

    /* ---------- rendering ---------- */

    /*
     * `slide` is a move event that just arrived from someone else. It
     * animates only if it is the move the replay actually applied: a
     * resign or a shrugged-off event leaves `lastMove` pointing at an
     * older move, and that one has already had its turn on screen.
     */
    function render({ live = false, slide = null } = {}) {
      const state = current();
      renderName();
      renderScore(state);
      renderStatus(state);
      clearTimeout(boardTimer);
      const arrived = !!(
        slide &&
        state.lastMove &&
        state.lastMove.seat === slide.seat &&
        state.lastMove.path.join() === String(slide.path)
      );
      const wait = arrived ? 0 : boardSettlesAt - performance.now();
      let motion = 0;
      if (wait > 0) boardTimer = setTimeout(() => renderBoard(current()), wait);
      else motion = renderBoard(state, arrived ? state.lastMove : null);
      renderActions(state);
      maybeCelebrate(state, live, arrived ? motion : Math.max(0, wait));
    }

    /*
     * The end-of-round moment, once per round, and only when the round
     * ends live in front of you — `live` marks an event that just
     * arrived. Opening or resyncing a finished game replays the board
     * but never the celebration; otherwise every refresh would set it
     * off again, and an async player would be met by a trophy for a
     * round that ended yesterday. `settle` is how long the final move
     * is still moving, so the moment waits for the last capture to pop.
     */
    function maybeCelebrate(state, live, settle) {
      if (!state.over) {
        // A rematch (yours or theirs) clears the board underneath.
        celebratedRound = null;
        clearCelebration();
        return;
      }
      if (!live || celebratedRound === state.round) return;
      celebratedRound = state.round;

      const { winner, reason } = state.over;
      let spec;
      // Playing both sides in hot seat, nobody "won" — name the winner.
      const viewer = hotseatActive() ? null : seat;
      if (winner === null) spec = CELEBRATIONS.draw;
      else if (winner === viewer) spec = CELEBRATIONS.win;
      else if (isPlayer(viewer)) spec = reason === "resign" ? CELEBRATIONS.resign : CELEBRATIONS.loss;
      // A spectator didn't lose — they watched somebody win, so they
      // get the win, retitled to name whose it was.
      else spec = { ...CELEBRATIONS.win, title: cap(winner) + " wins" };

      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(() => celebration.play(spec), settle + CELEBRATE_DELAY_MS);
    }

    /** Clear the moment, including one that hasn't opened yet. */
    function clearCelebration() {
      clearTimeout(celebrateTimer);
      celebration.dismiss();
    }

    /*
     * The game name in the HUD. Everyone sees it (code until named);
     * the creator (black) can click it to rename. While the input is
     * open, renders leave it alone so a presence blip doesn't eat a
     * half-typed name.
     */
    function renderName() {
      if (nameEl.querySelector("input")) return;
      nameEl.textContent = "";
      const display = gameName || code;
      if (connected && seat === "black") {
        const btn = el("button", "name-edit", display);
        btn.title = "Rename this game";
        btn.addEventListener("click", editName);
        nameEl.append(btn);
      } else {
        nameEl.append(el("span", null, display));
      }
    }

    function editName() {
      nameEl.textContent = "";
      const input = el("input", "name-input");
      input.value = gameName || "";
      input.placeholder = code;
      input.maxLength = MAX_NAME;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = gameName || "";
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        const name = input.value.trim();
        if (name && name !== gameName) {
          // The socket can die while the input is open; a rename typed
          // offline is queued and sent on the next welcome.
          if (connected && ws && ws.readyState === WebSocket.OPEN) {
            send({ type: "set_name", name });
          } else {
            queuedName = name;
          }
        }
        nameEl.textContent = "";
        renderName();
      });
      nameEl.append(input);
      input.focus();
      input.select();
    }

    function renderScore(state) {
      scoreEl.textContent = "";
      const chips = {};
      for (const player of PLAYERS) {
        const chip = el("span", "chip " + player + (presence[player] ? " on" : ""));
        if (seat === player) {
          chip.classList.add("you");
          chip.title = "You";
        } else {
          chip.title = cap(player) + (presence[player] ? " is here" : " is away");
        }
        chips[player] = chip;
      }
      scoreEl.append(
        chips.black,
        document.createTextNode(` ${state.score.black} — ${state.score.red} `),
        chips.red,
      );
    }

    function renderStatus(state) {
      statusEl.textContent = "";
      statusEl.append(el("span", null, statusText(state)));

      const left = drawIn(state);
      if (connected && left !== null && left <= DRAW_WARNING) {
        statusEl.append(el("span", "countdown", "· draw in " + left));
      }

      if (!connected || !seat) return;
      // One dot for everyone: colored by whoever's turn it is; grey
      // (base) when that player is away. Presence shows on the
      // scoreboard chips' pulse instead.
      const turn = state.turn;
      if (isPlayer(turn)) {
        const dot = el("span", "dot " + turn + (presence[turn] ? " on" : ""));
        dot.title = cap(turn) + " to move" + (presence[turn] ? " · here" : " · away");
        statusEl.append(dot);
      } else {
        const dot = el("span", "dot");
        dot.title = "Round over";
        statusEl.append(dot);
      }
    }

    function statusText(state) {
      if (!connected) return "Connecting…";
      // Playing both sides in hot seat reads like watching: no "you".
      const viewer = hotseatActive() ? null : seat;
      if (state.over) {
        const { winner, reason } = state.over;
        if (winner === null) return "Draw";
        if (reason === "resign") {
          const loser = otherSeat(winner);
          if (viewer === loser) return "You resigned";
          if (viewer === winner) return cap(loser) + " resigned · you win";
          return cap(loser) + " resigned";
        }
        return viewer === winner ? "You win this round" : cap(winner) + " wins this round";
      }
      if (hotseatActive()) return "Hot seat · " + cap(state.turn) + " to move";
      if (!isPlayer(seat)) return "Watching · " + cap(state.turn) + " to move";
      return state.turn === seat ? "Your turn" : cap(state.turn) + "’s turn";
    }

    function renderActions(state) {
      const playing = connected && isPlayer(seat);
      rematchBtn.hidden = !(playing && state.over);
      resignBtn.hidden = !(playing && !state.over);
      if (resignBtn.hidden) disarmResign();
    }

    /*
     * The board. Squares are rebuilt each time; pieces float above them
     * on their own layer, so a move can slide. Each player sees their
     * own pieces at the bottom — red's board is black's turned 180° —
     * and spectators see black's.
     *
     * `motion` animates one move onto the board: { path, captured,
     * crowned } — a whole move that just arrived, or the one hop just
     * tapped. `restored` lists squares whose pieces fade back in after a
     * mid-jump rewind. Returns how long the motion runs, in ms.
     */
    function renderBoard(state, motion = null, restored = []) {
      const hadFocus = boardEl.contains(document.activeElement);
      boardEl.textContent = "";
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

      const asRed = seat === "red";
      const place = (square) => {
        const { row, col } = coords(square);
        return asRed ? { r: row, c: col } : { r: 7 - row, c: 7 - col };
      };
      const squareFor = (r, c) => (asRed ? squareAt(r, c) : squareAt(7 - r, 7 - c));

      // What the player could do from here.
      const mover = actingSeat(state);
      const interactive = mover !== null;
      const moves = interactive ? legalMoves(state.board, mover) : [];
      const movable = nextSquares(moves, []);
      const mustCapture = moves.length > 0 && isJump(moves[0][0], moves[0][1]);
      const next = selection ? nextSquares(moves, selection) : [];
      const at = selection ? selection[selection.length - 1] : null;
      const targets = new Set(next.filter((n) => isJump(at, n)).map((n) => between(at, n)));

      // A move being tapped out shows its preview: the piece where it
      // has got to, the pieces it has jumped gone.
      const board = selection && selection.length > 1 ? applyMove(state.board, selection).board : state.board;

      // The last move's trail and ghosts step aside while a piece is
      // selected, and come back if it's let go.
      const last = state.lastMove;
      const trail = last && !selection ? new Set(last.path) : new Set();
      const ghosts = last && !selection ? last.captured.map((c) => c.square) : [];

      const live = new Set(selection ? [...next, selection[0]] : movable);
      if (selection && selection.length === 1) movable.forEach((n) => live.add(n));
      const tabStop = focusSquare ?? movable[0] ?? (seat === "red" ? 29 : 4);

      // Timing, if a move is animating: when each hop starts, and so when
      // each captured piece is passed over.
      const hops = motion ? motion.path.length - 1 : 0;
      const duration = motion && !still ? hops * HOP_MS + (hops - 1) * HOP_PAUSE_MS : 0;
      const hopStart = (i) => i * (HOP_MS + HOP_PAUSE_MS);
      const popAt = new Map();
      if (motion) {
        for (let i = 1; i < motion.path.length; i++) {
          if (isJump(motion.path[i - 1], motion.path[i])) {
            popAt.set(between(motion.path[i - 1], motion.path[i]), hopStart(i - 1) + HOP_MS / 2);
          }
        }
      }

      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const square = squareFor(r, c);
          const cell = el("div", "square");
          if (square === null) {
            boardEl.append(cell);
            continue;
          }
          cell.classList.add("dark");
          cell.dataset.square = square;
          cell.tabIndex = square === tabStop ? 0 : -1;
          cell.setAttribute("aria-label", squareLabel(square, board[square]));
          if (live.has(square)) cell.classList.add("live");
          if (trail.has(square)) cell.classList.add("trail");
          if (ghosts.includes(square)) {
            const ghost = el("div", "ghost");
            if (motion && !still && popAt.has(square)) {
              ghost.classList.add("arrive");
              ghost.style.setProperty("--delay", popAt.get(square) + POP_MS + "ms");
            }
            cell.append(ghost);
          }
          if (next.includes(square)) {
            cell.append(el("div", "marker " + (isJump(at, square) ? "jump" : "step")));
          }
          boardEl.append(cell);
        }
      }

      const cellSize = boardEl.clientWidth / 8;
      const offset = (square, scale = 1) => {
        const { r, c } = place(square);
        return `translate(${c * cellSize}px, ${r * cellSize}px)` + (scale === 1 ? "" : ` scale(${scale})`);
      };

      for (let square = 1; square <= 32; square++) {
        const piece = board[square];
        if (!piece) continue;
        const node = pieceNode(piece, place(square));
        if (selection && square === at && !pending) node.classList.add("selected");
        else if (!selection && mustCapture && movable.includes(square)) node.classList.add("must");
        if (targets.has(square)) node.classList.add("target");

        const moving = motion && square === motion.path[motion.path.length - 1];
        const isLast = last && square === last.path[last.path.length - 1] && !selection;
        if (moving && duration > 0) {
          node.animate(slideFrames(motion.path, offset, duration), { duration });
          if (motion.crowned) {
            const crown = node.querySelector(".crown");
            crown.classList.add("arrive");
            crown.style.setProperty("--delay", duration + "ms");
          }
          if (isLast) setTimeout(() => node.classList.add("last"), duration);
        } else if (isLast) {
          node.classList.add("last");
        }
        if (restored.includes(square) && !still) {
          node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RESTORE_MS, easing: "ease-out" });
        }
        boardEl.append(node);
      }

      // Captured pieces stay for their pop, then go.
      if (motion && !still) {
        for (const { square, piece } of motion.captured) {
          const node = pieceNode(piece, place(square));
          const pop = node.animate(
            [
              { transform: offset(square), opacity: 1, easing: "ease-out" },
              { transform: offset(square, POP_SWELL), opacity: 1, offset: POP_PEAK, easing: "ease-in" },
              { transform: offset(square, POP_SHRINK), opacity: 0 },
            ],
            { duration: POP_MS, delay: popAt.get(square) ?? 0, fill: "both" },
          );
          pop.finished.then(() => node.remove(), () => node.remove());
          boardEl.append(node);
        }
      }

      if (hadFocus && focusSquare !== null) {
        const target = boardEl.querySelector(`[data-square="${focusSquare}"]`);
        if (target) target.focus();
      }
      // Done once the slide ends and the last pop has played out.
      const popsEnd = still || popAt.size === 0 ? 0 : Math.max(...popAt.values()) + POP_MS;
      return Math.max(duration, popsEnd);
    }

    function pieceNode(piece, { r, c }) {
      const node = el("div", "piece " + piece.seat);
      node.style.setProperty("--r", r);
      node.style.setProperty("--c", c);
      if (piece.king) node.append(crownNode());
      return node;
    }

    function squareLabel(square, piece) {
      if (!piece) return "Square " + square + ", empty";
      return "Square " + square + ", " + piece.seat + (piece.king ? " king" : " piece");
    }

    /*
     * A slide along a path, hop by hop, with a short pause on each
     * landing so a double jump reads as two jumps.
     */
    function slideFrames(path, offset, duration) {
      const frames = [];
      for (let i = 0; i < path.length - 1; i++) {
        const start = i * (HOP_MS + HOP_PAUSE_MS);
        frames.push({ transform: offset(path[i]), offset: start / duration, easing: HOP_EASING });
        frames.push({ transform: offset(path[i + 1]), offset: (start + HOP_MS) / duration });
      }
      return frames;
    }

    /* ---------- input ---------- */

    boardEl.addEventListener("click", (e) => {
      // A tap on the board while disconnected is a fine reason to retry
      // right now instead of waiting out the backoff timer.
      if (!connected) {
        reconnectNow();
        return;
      }
      const cell = e.target.closest(".square.dark");
      if (!cell) return;
      focusSquare = Number(cell.dataset.square);
      tap(focusSquare);
    });

    // Keyboard: arrows move focus across the dark squares as the board
    // is shown; Enter or Space taps; Escape rewinds or lets go.
    boardEl.addEventListener("keydown", (e) => {
      const cell = e.target.closest(".square.dark");
      if (!cell) return;
      const square = Number(cell.dataset.square);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusSquare = square;
        tap(square);
        return;
      }
      if (e.key === "Escape") {
        cancelSelection();
        return;
      }
      const step = ARROWS[e.key];
      if (!step) return;
      e.preventDefault();
      const target = neighbor(cell, step);
      if (!target) return;
      cell.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
      focusSquare = Number(target.dataset.square);
    });

    // Escape from anywhere on the page lets go of a selection.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !boardEl.contains(e.target)) cancelSelection();
    });

    /** The dark square one arrow-press away, in the board as shown. */
    function neighbor(cell, [dr, dc]) {
      const cells = [...boardEl.children].filter((n) => n.classList.contains("square"));
      const index = cells.indexOf(cell);
      const r = Math.floor(index / 8);
      const c = index % 8;
      const candidates = dr === 0 ? [[r, c + dc * 2]] : [[r + dr, c - 1], [r + dr, c + 1]];
      for (const [nr, nc] of candidates) {
        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const found = cells[nr * 8 + nc];
        if (found && found.classList.contains("dark")) return found;
      }
      return null;
    }

    /* ---------- actions ---------- */

    shareBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        shareBtn.textContent = "Copied ✓";
        setTimeout(() => (shareBtn.textContent = "Copy link"), 1500);
      } catch {
        prompt("Copy the game link:", location.href);
      }
    });

    // Resign takes two taps: the first arms it for a few seconds.
    resignBtn.addEventListener("click", () => {
      if (!resignArmed) {
        resignArmed = true;
        resignBtn.textContent = "Confirm resign?";
        resignBtn.classList.add("armed");
        resignTimer = setTimeout(disarmResign, RESIGN_ARM_MS);
        return;
      }
      disarmResign();
      // In hot seat, the side to move is the one resigning.
      if (tryAppend({ kind: "resign" }, actingSeat(current()) ?? seat)) {
        selection = null;
        renderBoard(current());
      }
    });

    function disarmResign() {
      clearTimeout(resignTimer);
      resignArmed = false;
      resignBtn.textContent = "Resign";
      resignBtn.classList.remove("armed");
    }

    rematchBtn.addEventListener("click", () => {
      if (tryAppend({ kind: "new_round" })) render();
    });

    $("leave").addEventListener("click", () => {
      location.href = "/";
    });
  }
}

/* ================================================================
 * Celebration — the end-of-round moment.
 *
 * One full-viewport layer, back to front: a black scrim, a canvas of
 * settled paint, a canvas of paint still in flight, the verdict, and
 * an emoji centered on the board.
 *
 * The game code picks a spec and says "play". Everything else — the
 * DOM, the animation loop, the sizing, the teardown — lives in here.
 * The one thing that comes back out is `onUserDismiss`, called when
 * this viewer clears the layer themselves, so the caller can tell the
 * rest of the game about it.
 *
 * The splatter effect is our own canvas implementation, inspired by
 * confetti.ts by LoaderB0T (MIT) — https://github.com/LoaderB0T/confetti.ts
 * — but shares no code with it: this project ships zero third-party
 * assets, and a splat here is a closed-form ease rather than a
 * per-frame physics step.
 * ================================================================ */

/**
 * What each outcome plays. `entrance` names the emoji's arrival (a
 * matching `entrance-*` class drives it from the stylesheet), `dim` is
 * the opacity of the black scrim behind it, and `splatter` is the
 * paint. Winning keeps a lighter scrim than the other two: the paint
 * lands in front of it and wants a ground to read against, not a
 * blackout.
 *
 * `title` is the default; a spectator's is built at play time, since
 * nobody watching a game they aren't in has won or lost anything.
 */
const CELEBRATIONS = {
  win: { title: "You win", emoji: "🏆", entrance: "grow", splatter: true, dim: 0.5 },
  loss: { title: "You lose", emoji: "😞", entrance: "drop", splatter: false, dim: 0.85 },
  draw: { title: "Draw", emoji: "🤝", entrance: "slam", splatter: false, dim: 0.85 },
};
// Resigning is a loss you chose: the same moment, named for what happened.
CELEBRATIONS.resign = { ...CELEBRATIONS.loss, title: "You resign" };

// Just long enough after the final move has landed — the paint should
// read as starting with the win, not as a beat after it.
const CELEBRATE_DELAY_MS = 280;

function createCelebration(boardEl, onUserDismiss) {
  // Bright enough to read on either theme, and spread far enough
  // around the hue circle that three random picks rarely look like one
  // color. Indexed, not named: dots store the index so the dissolve can
  // batch thousands of them into a handful of fills.
  const PALETTE = [
    "oklch(63% 0.22 27)", // red
    "oklch(72% 0.19 55)", // orange
    "oklch(84% 0.17 95)", // yellow
    "oklch(74% 0.20 145)", // green
    "oklch(74% 0.14 195)", // teal
    "oklch(62% 0.19 258)", // blue
    "oklch(58% 0.24 300)", // violet
    "oklch(68% 0.23 350)", // pink
  ];

  // A splat's dots ease out to their resting distance and then never
  // move again — this is paint, not confetti. ~99% of the way by 5τ.
  const SETTLE_TAU = 110;
  const SETTLE_MS = 620;

  // Splats per second. The rate climbs for the whole build so the
  // field reads as still gathering pace, never as having levelled off.
  const RATE_START = 9;
  const RATE_END = 34;
  const RAMP_MS = 3000;
  // How fast the splats stop keeping to the top half and start landing
  // anywhere — quick, so it matches the emoji finishing its growth.
  const REGION_MS = 1200;
  // The paint budget for the whole show, set from the viewport in
  // measure(): one dot per this many CSS pixels of screen, so a phone
  // gets the same density as a desktop rather than the same count.
  // Accumulated paint costs nothing per frame — the ceiling is here
  // because the dissolve is the one pass that redraws every dot, and
  // that is the machine-dependent part.
  const PIXELS_PER_DOT = 142;
  const DOTS_FLOOR = 1800;
  const DOTS_CEILING = 4300;
  let maxDots = DOTS_CEILING;
  // Backstop, in case a viewport is big enough that the cap never lands.
  const SPAWN_MS = 9000;

  // Dissolve: every dot goes out on its own schedule, so the field
  // comes apart rather than blinking off as one sheet.
  const STAGGER_MS = 280;
  const DOT_FADE_MS = 170;
  const OUT_MS = STAGGER_MS + DOT_FADE_MS;
  // An emoji-only ending has no paint to dissolve; it just waits out
  // the stylesheet's fade.
  const PLAIN_OUT_MS = 240;

  // Alpha is quantized during the dissolve so a few thousand dots
  // collapse into (steps × colors) filled paths per frame.
  const ALPHA_STEPS = 6;
  const TWO_PI = Math.PI * 2;

  let layer = null;
  let dimEl = null;
  let titleEl = null;
  let emojiEl = null;
  // Settled paint. Drawn into once per splat and never cleared during
  // the show, so accumulated paint costs nothing per frame.
  let paint = null;
  let paintCtx = null;
  // Splats still expanding. Cleared and redrawn every frame — only
  // ever a handful.
  let fly = null;
  let flyCtx = null;

  let flying = []; // splats mid-expansion
  let pendingDots = 0; // dots the splats still flying will add to `dots`
  // Every droplet laid down: an ellipse { x, y, rx, ry, rot }, a palette
  // index `ci`, and `d`, its place in the dissolve queue.
  let dots = [];
  let centers = []; // splat centers so far, for spacing the next one
  let buckets = []; // reused dissolve draw buckets: [alphaStep][colorIndex]

  let raf = 0;
  let startedAt = 0;
  let lastFrame = 0;
  let owed = 0; // fractional splats carried between frames
  let closing = false;
  let closedAt = 0;
  let closeTimer = null;
  let w = 0;
  let h = 0;

  function build() {
    layer = document.createElement("div");
    layer.className = "celebration";
    // Decorative: the status line already announces the result.
    layer.setAttribute("aria-hidden", "true");

    dimEl = document.createElement("div");
    dimEl.className = "celebration-dim";
    paint = document.createElement("canvas");
    paint.className = "celebration-canvas";
    fly = document.createElement("canvas");
    fly.className = "celebration-canvas";
    titleEl = document.createElement("span");
    titleEl.className = "celebration-title";
    emojiEl = document.createElement("span");
    emojiEl.className = "celebration-emoji";

    layer.append(dimEl, paint, fly, titleEl, emojiEl);
    paintCtx = paint.getContext("2d");
    flyCtx = fly.getContext("2d");
    layer.addEventListener("pointerdown", userDismiss);

    for (let step = 0; step < ALPHA_STEPS; step++) {
      buckets.push(PALETTE.map(() => []));
    }
  }

  function measure() {
    w = window.innerWidth;
    h = window.innerHeight;
    maxDots = Math.max(
      DOTS_FLOOR,
      Math.min(Math.round((w * h) / PIXELS_PER_DOT), DOTS_CEILING),
    );
    // Cap the backing store at 2x: past that a phone pays for pixels
    // nobody can see in a field of 3px dots.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [canvas, context] of [[paint, paintCtx], [fly, flyCtx]]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Resizing blanks the backing store, so the settled paint has to be
    // laid down again. Dots keep their absolute positions — paint on a
    // wall doesn't reflow when the window changes shape.
    repaint();
    place();
  }

  /**
   * Center the emoji on the board, wherever the layout has put it, and
   * hang the title above it. Both are sized here rather than in the
   * stylesheet because both depend on the board — and on each other,
   * since the title has to fit in whatever room the emoji leaves.
   */
  function place() {
    const rect = boardEl.getBoundingClientRect();
    // Viewport height bounds the emoji too: a short landscape phone
    // would otherwise fill the screen and leave the title nowhere.
    const size = Math.max(
      101,
      Math.min(rect.width * 0.72, window.innerHeight * 0.34, 288),
    );
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    emojiEl.style.left = centerX + "px";
    emojiEl.style.top = centerY + "px";
    emojiEl.style.setProperty("--size", size + "px");
    // The grow starts at 12px, whatever the finished size works out to.
    emojiEl.style.setProperty("--from", (12 / size).toFixed(4));
    // The drop starts fully above the viewport, so it enters from off
    // screen however tall the window is or wherever the board sits.
    emojiEl.style.setProperty("--drop", centerY + size + "px");
    emojiEl.style.setProperty("--bounce", size * 0.06 + "px");

    // The title takes the largest size that clears the emoji, spans no
    // more than the viewport, and stays under a sane ceiling — the
    // width term is why "Yellow wins" on a narrow phone comes out
    // smaller than "Draw" does.
    const gap = Math.max(18, size * 0.12);
    const bottom = centerY - size / 2 - gap;
    const budget = window.innerWidth * 0.92;
    const chars = Math.max(4, titleEl.textContent.length);
    const titleSize = Math.max(
      24,
      Math.min(
        budget / (chars * 0.52), // across, optimistically — corrected below
        (bottom - 12) / 1.15, // above the emoji, leaving a top margin
        window.innerHeight * 0.13,
        96,
      ),
    );
    titleEl.style.left = centerX + "px";
    titleEl.style.top = bottom + "px";
    titleEl.style.setProperty("--title-size", titleSize + "px");

    // Character counting only estimates a proportional font's width, so
    // measure what actually rendered and scale back if the glyphs came
    // out wider than the budget. Exact beats guessing, and it means the
    // guess above can afford to be generous.
    const actual = titleEl.offsetWidth;
    if (actual > budget) {
      titleEl.style.setProperty("--title-size", (titleSize * budget) / actual + "px");
    }
  }

  /** Lay every settled dot back down, one filled path per color. */
  function repaint() {
    paintCtx.clearRect(0, 0, w, h);
    for (let ci = 0; ci < PALETTE.length; ci++) {
      let drew = false;
      paintCtx.fillStyle = PALETTE[ci];
      paintCtx.beginPath();
      for (const dot of dots) {
        if (dot.ci !== ci) continue;
        drew = true;
        blob(paintCtx, dot.x, dot.y, dot.rx, dot.ry, dot.rot);
      }
      if (drew) paintCtx.fill();
    }
  }

  /**
   * One droplet inside a batched path — an ellipse, not a circle:
   * thrown paint stretches along its flight, and a field of perfect
   * circles reads as dots rather than splatter. Costs the same as an
   * arc and batches identically.
   *
   * The moveTo is not optional, and has to land on the ellipse's own
   * start point: without it each shape joins the previous one and the
   * whole path fills as a web of connecting lines.
   */
  function blob(context, x, y, rx, ry, rot) {
    context.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
    context.ellipse(x, y, rx, ry, rot, 0, TWO_PI);
  }

  /**
   * Where the next splat lands. Uniform random clumps and leaves bald
   * patches; taking the farthest of a few candidates from the paint
   * already down spreads the field over the whole viewport without
   * ever looking like it was laid out on a grid.
   */
  function pickSpot(region) {
    // Centers stay off the edges, though the paint itself may bleed past.
    const pad = Math.min(w, h) * 0.1;
    const band = h * (0.5 + 0.5 * region); // top half at first, all of it later
    let best = null;
    let bestGap = -1;
    for (let i = 0; i < 3; i++) {
      const x = pad + Math.random() * Math.max(1, w - pad * 2);
      const y = pad + Math.random() * Math.max(1, band - pad * 2);
      let gap = Infinity;
      for (const other of centers) {
        const dx = other.x - x;
        const dy = other.y - y;
        gap = Math.min(gap, dx * dx + dy * dy);
      }
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y };
      }
    }
    return best;
  }

  function spawn(now, region) {
    const { x, y } = pickSpot(region);
    centers.push({ x, y });

    const size = Math.min(w, h);
    const reach = size * (0.11 + Math.random() * 0.14);
    // Dots scale with the viewport so a phone doesn't get a coarser
    // splat than a desktop.
    const grain = Math.min(1.35, Math.max(0.7, size / 720));
    const count = 24 + Math.floor(Math.random() * 15);

    // Three colors per splat, dots bucketed by color at birth, so
    // drawing one mid-flight splat is three filled paths.
    const groups = [
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
    ];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TWO_PI;
      // Biased outward so the splat has a dense middle and a few fliers.
      const distance = reach * Math.pow(Math.random(), 0.55);
      const r = (1.3 + Math.pow(Math.random(), 2) * 3.6) * grain;
      // The further a droplet was thrown the more it stretches, and
      // most stay near-round — a field where every dot is elongated
      // looks combed rather than splattered. `stretch` is the long/short
      // axis ratio, so this tops out at a gentle 2:1 with the typical
      // droplet nearer 1.2:1. Area is held constant, so shape changes
      // without coverage changing with it.
      const stretch = 1 + (distance / reach) * Math.pow(Math.random(), 1.5) * 1.0;
      const skew = Math.sqrt(stretch);
      groups[i % 3].pts.push({
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance,
        rx: r * skew,
        ry: r / skew,
        // Along the flight path, loosened a little so the field doesn't
        // read as a starburst of perfectly radial strokes.
        rot: angle + (Math.random() - 0.5) * 0.7,
      });
    }
    pendingDots += count;
    // Born on the frame's clock, not performance.now(): the frame
    // timestamp trails the real one, and a splat born "in the future"
    // reads as a negative age and briefly implodes instead of bursting.
    flying.push({ x, y, born: now, count, groups });
  }

  /**
   * Move a splat off the live list and into the settled paint. `spread`
   * is where its dots have got to (1 once it has finished): dismissing
   * mid-burst has to freeze them where they are, or a splat that is
   * 100ms old snaps to full size on the way out.
   */
  function settle(splat, spread) {
    pendingDots -= splat.count;
    for (const group of splat.groups) {
      paintCtx.fillStyle = PALETTE[group.ci];
      paintCtx.beginPath();
      for (const pt of group.pts) {
        const x = splat.x + pt.dx * spread;
        const y = splat.y + pt.dy * spread;
        blob(paintCtx, x, y, pt.rx, pt.ry, pt.rot);
        // `d` is this dot's place in the dissolve queue, fixed now so
        // the order is scattered rather than following the paint order.
        dots.push({ x, y, rx: pt.rx, ry: pt.ry, rot: pt.rot, ci: group.ci, d: Math.random() });
      }
      paintCtx.fill();
    }
  }

  function spawning(age) {
    return age < SPAWN_MS && dots.length + pendingDots < maxDots;
  }

  function advance(now, age, dt) {
    if (spawning(age)) {
      const rate = RATE_START + (RATE_END - RATE_START) * Math.min(1, age / RAMP_MS);
      const region = Math.min(1, age / REGION_MS);
      owed += rate * (dt / 1000);
      while (owed >= 1 && spawning(age)) {
        owed -= 1;
        spawn(now, region);
      }
      owed = Math.min(owed, 1); // never bank a backlog that dumps as one burst
    }

    flyCtx.clearRect(0, 0, w, h);
    let live = 0;
    for (let i = 0; i < flying.length; i++) {
      const splat = flying[i];
      const splatAge = now - splat.born;
      if (splatAge >= SETTLE_MS) {
        settle(splat, 1);
        continue;
      }
      flying[live++] = splat;
      const spread = 1 - Math.exp(-splatAge / SETTLE_TAU);
      for (const group of splat.groups) {
        flyCtx.fillStyle = PALETTE[group.ci];
        flyCtx.beginPath();
        for (const pt of group.pts) {
          blob(flyCtx, splat.x + pt.dx * spread, splat.y + pt.dy * spread, pt.rx, pt.ry, pt.rot);
        }
        flyCtx.fill();
      }
    }
    flying.length = live;
  }

  /** The dissolve: each dot fades on its own clock, staggered by `d`. */
  function dissolve(now) {
    const t = now - closedAt;
    for (const row of buckets) {
      for (const bucket of row) bucket.length = 0;
    }
    for (const dot of dots) {
      const alpha = 1 - (t - dot.d * STAGGER_MS) / DOT_FADE_MS;
      if (alpha <= 0) continue;
      const step = alpha >= 1 ? ALPHA_STEPS - 1 : Math.floor(alpha * ALPHA_STEPS);
      buckets[step][dot.ci].push(dot);
    }

    paintCtx.clearRect(0, 0, w, h);
    for (let step = 0; step < ALPHA_STEPS; step++) {
      paintCtx.globalAlpha = (step + 1) / ALPHA_STEPS;
      for (let ci = 0; ci < PALETTE.length; ci++) {
        const bucket = buckets[step][ci];
        if (bucket.length === 0) continue;
        paintCtx.fillStyle = PALETTE[ci];
        paintCtx.beginPath();
        for (const dot of bucket) blob(paintCtx, dot.x, dot.y, dot.rx, dot.ry, dot.rot);
        paintCtx.fill();
      }
    }
    paintCtx.globalAlpha = 1;
  }

  function frame(now) {
    // Clamped both ways: a backgrounded tab resumes with a huge gap,
    // and the first frame's timestamp can trail the play() call that
    // set the clock.
    const dt = Math.max(0, Math.min(50, now - lastFrame));
    lastFrame = now;

    if (closing) {
      dissolve(now);
      if (now - closedAt >= OUT_MS) {
        teardown();
        return;
      }
    } else {
      const age = now - startedAt;
      advance(now, age, dt);
      // Once the paint is down and nothing is in flight the picture is
      // finished: stop the loop entirely rather than redrawing a static
      // field until someone clicks. The canvas keeps what it holds.
      if (!spawning(age) && flying.length === 0) {
        raf = 0;
        return;
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function onKey(e) {
    if (e.key !== "Escape" && e.key !== "Enter" && e.key !== " ") return;
    // Capture and swallow: a board square can still hold focus behind
    // the layer, and Enter there would tap it instead of dismissing.
    e.preventDefault();
    e.stopPropagation();
    userDismiss();
  }

  function teardown() {
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(closeTimer);
    closeTimer = null;
    flying = [];
    dots = [];
    centers = [];
    pendingDots = 0;
    owed = 0;
    closing = false;
    window.removeEventListener("resize", measure);
    window.removeEventListener("keydown", onKey, true);
    if (layer) layer.remove();
  }

  /**
   * Dismissal the local viewer asked for, as opposed to one arriving
   * from the other end of the game. Only this path reports back — a
   * relayed dismissal that echoed would bounce between clients.
   */
  function userDismiss() {
    if (dismiss() && onUserDismiss) onUserDismiss();
  }

  /** Returns whether there was anything to dismiss. */
  function dismiss() {
    if (!layer || !layer.isConnected || closing) return false;
    closing = true;
    closedAt = performance.now();
    // `lit` comes off as `out` goes on: the entrance rules are keyed on
    // it, and while they match they outrank the exit rules and the
    // arrival animation would go on holding the emoji in place.
    layer.classList.remove("lit");
    layer.classList.add("out");

    // Anything still in flight joins the paint where it currently is,
    // so the dissolve accounts for every dot on screen.
    for (const splat of flying) {
      const splatAge = Math.min(SETTLE_MS, closedAt - splat.born);
      settle(splat, 1 - Math.exp(-Math.max(0, splatAge) / SETTLE_TAU));
    }
    flying.length = 0;
    if (flyCtx) flyCtx.clearRect(0, 0, w, h);

    if (dots.length === 0) {
      // Emoji-only ending: nothing to dissolve, just outlast the fade.
      cancelAnimationFrame(raf);
      raf = 0;
      closeTimer = setTimeout(teardown, PLAIN_OUT_MS);
      return true;
    }
    if (!raf) {
      lastFrame = closedAt;
      raf = requestAnimationFrame(frame);
    }
    return true;
  }

  return {
    play(spec) {
      if (layer && layer.isConnected) teardown(); // a new ending supersedes
      if (!layer) build();

      // Both set before measure(), which sizes the title from its text.
      titleEl.textContent = spec.title;
      emojiEl.textContent = spec.emoji;
      layer.style.setProperty("--dim", String(spec.dim));
      // `scrim` is what the title reads to know it is over black rather
      // than over the page, and so which color it has to be.
      layer.className =
        "celebration entrance-" + spec.entrance + (spec.dim > 0 ? " scrim" : "");
      document.body.append(layer);
      measure();
      window.addEventListener("resize", measure);
      window.addEventListener("keydown", onKey, true);
      // Next frame, so the animation and transitions run from their
      // start values instead of collapsing into the initial style.
      requestAnimationFrame(() => {
        if (layer && layer.isConnected) layer.classList.add("lit");
      });

      // Reduced motion keeps the emoji (it carries the meaning) and
      // drops the paint entirely.
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!spec.splatter || still) return;
      startedAt = performance.now();
      lastFrame = startedAt;
      // Prime the field so the first splats land on the opening frame
      // rather than a rate-interval later — the paint should start with
      // the win, not just after it.
      owed = 3;
      raf = requestAnimationFrame(frame);
    },

    /** Idempotent, and safe to call when nothing is playing. */
    dismiss,
  };
}

// Last, so every module-level constant above is initialized first.
if (typeof document !== "undefined") main();
