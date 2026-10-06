/*
 * The rules of American checkers, and the replay that derives a game
 * from its event log. Pure functions over plain data, no DOM: the page
 * imports this, and so does the node:test suite. The server knows none
 * of it — see docs/architecture.md.
 *
 * A board is an array indexed by square in standard notation, 1–32
 * (index 0 unused). Each entry is null or { seat, king }. Squares sit on
 * an 8×8 grid of (row, col): row 0 is black's back row (squares 1–4),
 * and each row holds four dark squares, offset by one on alternate rows.
 */

// Plies with no capture and no man moving before a round is drawn:
// 40 moves per side.
export const QUIET_LIMIT = 80;

const SEATS = ["black", "red"];

// Black men advance down the grid (rows increasing); red men advance up.
const FORWARD = { black: 1, red: -1 };

const DIRECTIONS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];


/* ---------------- geometry ---------------- */

export function coords(square) {
  const row = Math.floor((square - 1) / 4);
  const index = (square - 1) % 4;
  return { row, col: row % 2 === 0 ? index * 2 + 1 : index * 2 };
}

/** The square at (row, col), or null for a light or off-board square. */
export function squareAt(row, col) {
  if (row < 0 || row > 7 || col < 0 || col > 7) return null;
  if ((row + col) % 2 === 0) return null;
  return row * 4 + Math.floor(col / 2) + 1;
}

/** The square jumped over between two squares two diagonals apart. */
export function between(from, to) {
  const a = coords(from);
  const b = coords(to);
  return squareAt((a.row + b.row) / 2, (a.col + b.col) / 2);
}

/** Whether a hop between two squares is a jump rather than a step. */
export function isJump(from, to) {
  return Math.abs(coords(from).row - coords(to).row) === 2;
}

function crownRow(seat) {
  return seat === "black" ? 7 : 0;
}

/** Directions this piece may travel: kings any, men forward only. */
function directionsFor(piece) {
  return piece.king ? DIRECTIONS : DIRECTIONS.filter(([dr]) => dr === FORWARD[piece.seat]);
}


/* ---------------- boards ---------------- */

export function emptyBoard() {
  return new Array(33).fill(null);
}

export function initialBoard() {
  const board = emptyBoard();
  for (let n = 1; n <= 12; n++) board[n] = { seat: "black", king: false };
  for (let n = 21; n <= 32; n++) board[n] = { seat: "red", king: false };
  return board;
}

export function otherSeat(seat) {
  return seat === "black" ? "red" : "black";
}


/* ---------------- legal moves ---------------- */

/**
 * Every complete jump sequence for the piece on `from`. Jumped squares
 * are remembered so no piece is taken twice (a landing square can never
 * be one of them: landings and jumped squares sit on different
 * diagonals' parities).
 */
function jumpsFrom(board, from, piece) {
  const paths = [];

  function extend(path, at, taken) {
    let extended = false;
    const { row, col } = coords(at);
    for (const [dr, dc] of directionsFor(piece)) {
      const over = squareAt(row + dr, col + dc);
      const land = squareAt(row + dr * 2, col + dc * 2);
      if (over === null || land === null) continue;
      const victim = board[over];
      if (!victim || victim.seat === piece.seat || taken.has(over)) continue;
      // The jumper's own starting square is empty once it has left.
      if (board[land] && land !== from) continue;

      extended = true;
      // The piece jumps as what it was when the turn began, so a man
      // landing on its crowning row has nowhere forward left to go —
      // which is exactly the rule that crowning ends the turn.
      extend([...path, land], land, new Set(taken).add(over));
    }
    if (!extended && path.length > 1) paths.push(path);
  }

  extend([from], from, new Set());
  return paths;
}

/**
 * All complete, legal turns for `seat`, each as a path of squares. When
 * any capture exists, only captures are legal (in any sequence the
 * player chooses — the longest is not required).
 */
export function legalMoves(board, seat) {
  const jumps = [];
  const steps = [];
  for (let from = 1; from <= 32; from++) {
    const piece = board[from];
    if (!piece || piece.seat !== seat) continue;
    jumps.push(...jumpsFrom(board, from, piece));
    const { row, col } = coords(from);
    for (const [dr, dc] of directionsFor(piece)) {
      const to = squareAt(row + dr, col + dc);
      if (to !== null && !board[to]) steps.push([from, to]);
    }
  }
  return jumps.length > 0 ? jumps : steps;
}

function samePath(a, b) {
  return a.length === b.length && a.every((square, i) => square === b[i]);
}

export function isLegal(board, seat, path) {
  return legalMoves(board, seat).some((legal) => samePath(legal, path));
}

/**
 * The squares that can come next after a partial path, given the legal
 * moves: with an empty path, the movable pieces; after that, the next
 * landing squares. Empty once the path is a complete move.
 */
export function nextSquares(moves, partial) {
  const next = new Set();
  for (const path of moves) {
    if (path.length <= partial.length) continue;
    if (partial.every((square, i) => path[i] === square)) next.add(path[partial.length]);
  }
  return [...next];
}

/**
 * Play a path assumed legal. Returns the new board (the input is not
 * touched), the pieces captured in order, and whether the mover crowned.
 */
export function applyMove(board, path) {
  const next = board.slice();
  const from = path[0];
  const to = path[path.length - 1];
  const piece = next[from];
  const captured = [];

  for (let i = 1; i < path.length; i++) {
    if (!isJump(path[i - 1], path[i])) continue;
    const over = between(path[i - 1], path[i]);
    captured.push({ square: over, piece: next[over] });
    next[over] = null;
  }

  const crowned = !piece.king && coords(to).row === crownRow(piece.seat);
  next[from] = null;
  next[to] = crowned ? { seat: piece.seat, king: true } : piece;
  return { board: next, captured, crowned };
}


/* ---------------- replay ---------------- */

function starter(round) {
  return round % 2 === 1 ? "black" : "red";
}

export function initialState() {
  return {
    round: 1,
    board: initialBoard(),
    turn: "black",
    // { winner: "black" | "red" | null (draw), reason: "win" | "resign" | "draw" }
    over: null,
    score: { black: 0, red: 0 },
    quiet: 0,
    // { seat, path, captured: [{ square, piece }], crowned }
    lastMove: null,
  };
}

function finish(state, winner, reason) {
  const score = winner ? { ...state.score, [winner]: state.score[winner] + 1 } : state.score;
  return { ...state, over: { winner, reason }, turn: null, score };
}

function validPath(path) {
  return (
    Array.isArray(path) &&
    path.length >= 2 &&
    path.every((square) => Number.isInteger(square) && square >= 1 && square <= 32)
  );
}

/**
 * Fold one event into the state. Derivation is where the rules live, so
 * it is also where impossible history is filtered: anything the rules
 * can't produce — out of turn, an illegal or incomplete path, a move or
 * resignation after the round ended, new_round before it ended — returns
 * the state unchanged.
 */
export function step(state, event) {
  if (!event || typeof event !== "object") return state;

  if (event.kind === "new_round") {
    if (!state.over) return state;
    const round = state.round + 1;
    return {
      ...initialState(),
      round,
      turn: starter(round),
      score: state.score,
    };
  }

  if (state.over || !SEATS.includes(event.seat)) return state;

  if (event.kind === "resign") {
    return finish(state, otherSeat(event.seat), "resign");
  }

  if (event.kind !== "move" || event.seat !== state.turn || !validPath(event.path)) {
    return state;
  }
  if (!isLegal(state.board, event.seat, event.path)) return state;

  const mover = state.board[event.path[0]];
  const { board, captured, crowned } = applyMove(state.board, event.path);
  const quiet = captured.length > 0 || !mover.king ? 0 : state.quiet + 1;
  const next = {
    ...state,
    board,
    turn: otherSeat(event.seat),
    quiet,
    lastMove: { seat: event.seat, path: event.path.slice(), captured, crowned },
  };

  if (legalMoves(board, next.turn).length === 0) return finish(next, event.seat, "win");
  if (quiet >= QUIET_LIMIT) return finish(next, null, "draw");
  return next;
}

export function derive(log) {
  return log.reduce(step, initialState());
}

/**
 * Moves per side left before the 40-move draw, rounded up; null once
 * the round is over.
 */
export function drawIn(state) {
  if (state.over) return null;
  return Math.ceil((QUIET_LIMIT - state.quiet) / 2);
}
