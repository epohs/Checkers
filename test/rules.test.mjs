// Rules of American checkers, as derived from the event log.
// Positions are written as (row, col) on the 8×8 grid — row 0 is black's
// back row (squares 1–4), col 0 is the left edge as red sees it — and
// converted to standard 1–32 notation by `sq`, kept independent of the
// module under test so the geometry is checked rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUIET_LIMIT,
  coords,
  squareAt,
  initialBoard,
  emptyBoard,
  legalMoves,
  isLegal,
  applyMove,
  nextSquares,
  initialState,
  step,
  derive,
  drawIn,
} from "../public/rules.js";


/* ---------------- helpers ---------------- */

function sq(row, col) {
  assert.equal((row + col) % 2, 1, `(${row}, ${col}) is a light square`);
  return row * 4 + Math.floor(col / 2) + 1;
}

const man = (seat) => ({ seat, king: false });
const king = (seat) => ({ seat, king: true });

function boardWith(pieces) {
  const board = emptyBoard();
  for (const [square, piece] of pieces) board[square] = piece;
  return board;
}

function stateWith(pieces, turn, extra = {}) {
  return { ...initialState(), board: boardWith(pieces), turn, ...extra };
}

const move = (seat, ...path) => ({ kind: "move", path, seat });

const sorted = (paths) => paths.map((p) => p.join("-")).sort();


/* ---------------- notation ---------------- */

test("notation maps squares onto the dark squares", () => {
  assert.deepEqual(coords(1), { row: 0, col: 1 });
  assert.deepEqual(coords(4), { row: 0, col: 7 });
  assert.deepEqual(coords(5), { row: 1, col: 0 });
  assert.deepEqual(coords(29), { row: 7, col: 0 });
  assert.deepEqual(coords(32), { row: 7, col: 6 });
  for (let n = 1; n <= 32; n++) {
    const { row, col } = coords(n);
    assert.equal(squareAt(row, col), n);
    assert.equal(sq(row, col), n);
  }
  assert.equal(squareAt(0, 0), null);
  assert.equal(squareAt(-1, 1), null);
  assert.equal(squareAt(8, 1), null);
});

test("the opening position: black on 1–12, red on 21–32, black to move", () => {
  const board = initialBoard();
  for (let n = 1; n <= 32; n++) {
    if (n <= 12) assert.deepEqual(board[n], man("black"));
    else if (n >= 21) assert.deepEqual(board[n], man("red"));
    else assert.equal(board[n], null);
  }
  assert.equal(initialState().turn, "black");
  assert.deepEqual(
    sorted(legalMoves(board, "black")),
    sorted([[9, 13], [9, 14], [10, 14], [10, 15], [11, 15], [11, 16], [12, 16]]),
  );
});


/* ---------------- moving and capturing ---------------- */

test("captures are mandatory, and the player chooses between them", () => {
  // 11-15 22-18: black must take 15x22, then red chooses 25x18 or 26x17.
  let state = derive([move("black", 11, 15), move("red", 22, 18)]);
  assert.deepEqual(legalMoves(state.board, "black"), [[15, 22]]);
  assert.equal(isLegal(state.board, "black", [9, 13]), false);

  state = step(state, move("black", 15, 22));
  assert.equal(state.board[18], null, "the jumped piece is gone");
  assert.deepEqual(sorted(legalMoves(state.board, "red")), sorted([[25, 18], [26, 17]]));
});

test("men move and capture forward only", () => {
  const board = boardWith([
    [sq(4, 3), man("black")],
    [sq(3, 2), man("red")], // behind black: not capturable by a man
  ]);
  assert.deepEqual(
    sorted(legalMoves(board, "black")),
    sorted([[sq(4, 3), sq(5, 2)], [sq(4, 3), sq(5, 4)]]),
  );
});

test("kings move and capture in every direction, one square at a time", () => {
  const board = boardWith([
    [sq(4, 3), king("black")],
    [sq(3, 2), man("red")],
  ]);
  assert.deepEqual(legalMoves(board, "black"), [[sq(4, 3), sq(2, 1)]]);

  const lone = boardWith([[sq(4, 3), king("red")]]);
  assert.deepEqual(
    sorted(legalMoves(lone, "red")),
    sorted([
      [sq(4, 3), sq(3, 2)],
      [sq(4, 3), sq(3, 4)],
      [sq(4, 3), sq(5, 2)],
      [sq(4, 3), sq(5, 4)],
    ]),
  );
});

test("multi-jumps must be finished, and branches are the player's choice", () => {
  const board = boardWith([
    [sq(2, 1), man("black")],
    [sq(3, 2), man("red")],
    [sq(5, 4), man("red")],
    [sq(5, 2), man("red")],
  ]);
  assert.deepEqual(
    sorted(legalMoves(board, "black")),
    sorted([
      [sq(2, 1), sq(4, 3), sq(6, 5)],
      [sq(2, 1), sq(4, 3), sq(6, 1)],
    ]),
  );
  assert.equal(isLegal(board, "black", [sq(2, 1), sq(4, 3)]), false, "stopping early");
});

test("a piece is never jumped twice in one turn", () => {
  // A king ringed by four men jumps all the way around back to where it
  // started — and must stop there rather than going round again.
  const board = boardWith([
    [sq(2, 3), king("black")],
    [sq(3, 4), man("red")],
    [sq(5, 4), man("red")],
    [sq(5, 2), man("red")],
    [sq(3, 2), man("red")],
  ]);
  const moves = legalMoves(board, "black");
  assert.equal(Math.max(...moves.map((p) => p.length)), 5, "the full loop is found");
  for (const path of moves) {
    const captured = applyMove(board, path).captured.map((c) => c.square);
    assert.equal(new Set(captured).size, captured.length);
  }
});

test("crowning ends the turn, even mid-jump", () => {
  const board = boardWith([
    [sq(5, 2), man("black")],
    [sq(6, 3), man("red")],
    [sq(6, 5), man("red")], // a king could take this next; a fresh crown can't
  ]);
  assert.deepEqual(legalMoves(board, "black"), [[sq(5, 2), sq(7, 4)]]);
  const result = applyMove(board, [sq(5, 2), sq(7, 4)]);
  assert.equal(result.crowned, true);
  assert.deepEqual(result.board[sq(7, 4)], king("black"));
});

test("red crowns on squares 1–4", () => {
  const board = boardWith([[sq(1, 2), man("red")]]);
  const result = applyMove(board, [sq(1, 2), sq(0, 1)]);
  assert.equal(result.crowned, true);
  assert.deepEqual(result.board[sq(0, 1)], king("red"));
});

test("applyMove reports what it captured", () => {
  const board = boardWith([
    [sq(2, 1), man("black")],
    [sq(3, 2), man("red")],
    [sq(5, 4), king("red")],
  ]);
  const result = applyMove(board, [sq(2, 1), sq(4, 3), sq(6, 5)]);
  assert.deepEqual(result.captured, [
    { square: sq(3, 2), piece: man("red") },
    { square: sq(5, 4), piece: king("red") },
  ]);
  assert.equal(board[sq(3, 2)] !== null, true, "the input board is not mutated");
});


/* ---------------- tapping out a move ---------------- */

test("nextSquares walks a path hop by hop", () => {
  const board = boardWith([
    [sq(2, 1), man("black")],
    [sq(3, 2), man("red")],
    [sq(5, 4), man("red")],
    [sq(5, 2), man("red")],
    [sq(0, 7), man("black")], // can step, but a capture elsewhere is mandatory
  ]);
  const moves = legalMoves(board, "black");
  assert.deepEqual(nextSquares(moves, []), [sq(2, 1)], "only the capturing piece is movable");
  assert.deepEqual(nextSquares(moves, [sq(2, 1)]), [sq(4, 3)]);
  assert.deepEqual(nextSquares(moves, [sq(2, 1), sq(4, 3)]).sort(), [sq(6, 1), sq(6, 5)].sort());
  assert.deepEqual(nextSquares(moves, [sq(2, 1), sq(4, 3), sq(6, 5)]), []);
});


/* ---------------- ending a round ---------------- */

test("taking the last piece wins the round", () => {
  const state = step(
    stateWith([[sq(2, 1), man("black")], [sq(3, 2), man("red")]], "black"),
    move("black", sq(2, 1), sq(4, 3)),
  );
  assert.deepEqual(state.over, { winner: "black", reason: "win" });
  assert.deepEqual(state.score, { black: 1, red: 0 });
  assert.equal(state.turn, null);
});

test("leaving the opponent with no legal move wins the round", () => {
  // Red's only man sits on 5 with black on 1 ahead of it: no step, no jump.
  const state = step(
    stateWith(
      [[sq(1, 0), man("red")], [sq(0, 1), man("black")], [sq(4, 5), king("black")]],
      "black",
    ),
    move("black", sq(4, 5), sq(3, 6)),
  );
  assert.deepEqual(state.over, { winner: "black", reason: "win" });
});

test("40 moves per side with no capture and no man moving is a draw", () => {
  const kings = [[sq(0, 1), king("black")], [sq(7, 6), king("red")]];
  let state = stateWith(kings, "black", { quiet: QUIET_LIMIT - 2 });
  assert.equal(drawIn(state), 1);

  state = step(state, move("black", sq(0, 1), sq(1, 2)));
  assert.equal(state.over, null);
  state = step(state, move("red", sq(7, 6), sq(6, 5)));
  assert.deepEqual(state.over, { winner: null, reason: "draw" });
  assert.deepEqual(state.score, { black: 0, red: 0 });
  assert.equal(drawIn(state), null);
});

test("a man moving or any capture resets the draw count", () => {
  let state = stateWith(
    [[sq(0, 1), king("black")], [sq(2, 3), man("black")], [sq(7, 6), king("red")]],
    "black",
    { quiet: 60 },
  );
  assert.equal(drawIn(state), 10);
  state = step(state, move("black", sq(0, 1), sq(1, 2)));
  assert.equal(state.quiet, 61);
  assert.equal(drawIn(state), 10, "counted in moves per side, rounded up");
  state = step(state, move("red", sq(7, 6), sq(6, 5)));
  state = step(state, move("black", sq(2, 3), sq(3, 4)));
  assert.equal(state.quiet, 0);
  assert.equal(drawIn(state), 40);
});

test("either seat may resign at any time while the round is live", () => {
  const opened = derive([move("black", 11, 15)]);
  // Red resigns on its own turn; black resigns on red's turn.
  for (const [seat, winner] of [["red", "black"], ["black", "red"]]) {
    const state = step(opened, { kind: "resign", seat });
    assert.deepEqual(state.over, { winner, reason: "resign" });
    assert.equal(state.score[winner], 1);
  }
});


/* ---------------- rounds ---------------- */

test("the starting seat alternates each round and score accumulates", () => {
  let state = derive([
    move("black", 11, 15),
    { kind: "resign", seat: "red" },
    { kind: "new_round" },
  ]);
  assert.equal(state.round, 2);
  assert.equal(state.turn, "red");
  assert.deepEqual(state.board, initialBoard());
  assert.deepEqual(state.score, { black: 1, red: 0 });
  assert.equal(state.lastMove, null);

  state = step(state, move("red", 22, 18));
  state = step(state, { kind: "resign", seat: "red" });
  state = step(state, { kind: "new_round" });
  assert.equal(state.round, 3);
  assert.equal(state.turn, "black");
  assert.deepEqual(state.score, { black: 2, red: 0 });
});


/* ---------------- replay filters impossible history ---------------- */

test("replay shrugs off events the rules can't produce", () => {
  const base = derive([move("black", 11, 15), move("red", 22, 18)]);
  const shrugged = [
    move("red", 21, 17), // out of turn
    move("black", 9, 13), // misses the mandatory capture
    move("black", 15, 22, 29), // not a real jump sequence
    move("black", 15), // too short
    { kind: "move", path: "15-22", seat: "black" }, // malformed
    { kind: "move", path: [15, 22], seat: "spectator" }, // no such seat
    { kind: "move", path: [15, 22] }, // unstamped
    { kind: "new_round" }, // round still live
    { kind: "resign", seat: "spectator" },
    { kind: "nonsense" },
  ];
  for (const event of shrugged) {
    assert.deepEqual(step(base, event), base, JSON.stringify(event));
  }
});

test("nothing but new_round moves a finished round", () => {
  const over = derive([move("black", 11, 15), { kind: "resign", seat: "black" }]);
  assert.deepEqual(step(over, move("red", 22, 18)), over);
  assert.deepEqual(step(over, { kind: "resign", seat: "red" }), over);
});

test("an incomplete jump in the log is ignored", () => {
  const state = stateWith(
    [[sq(2, 1), man("black")], [sq(3, 2), man("red")], [sq(5, 4), man("red")]],
    "black",
  );
  assert.deepEqual(step(state, move("black", sq(2, 1), sq(4, 3))), state);
});


/* ---------------- last move ---------------- */

test("lastMove carries the path, the mover, and what was captured", () => {
  const state = derive([move("black", 11, 15), move("red", 22, 18), move("black", 15, 22)]);
  assert.deepEqual(state.lastMove, {
    seat: "black",
    path: [15, 22],
    captured: [{ square: 18, piece: man("red") }],
    crowned: false,
  });
});
