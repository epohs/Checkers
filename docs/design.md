# Design

The visual bar: minimal, quiet, and it should look *nice* — not merely functional — on a desktop browser window, an iPad, and an iPhone. Verify on real Safari during development.

## Pages

### Landing (`/`)

Truly minimal:

- Wordmark ("Checkers") and a one-line description.
- A single **New game** action → generates a code client-side, navigates to `/g/<code>`.
- A **Recent games** list from localStorage, shown only when non-empty and capped at the ten most recent. Each row carries a chip in the seat you hold there (neutral if you only watched), the game's **name** — or its code, until someone names it — an "in progress" badge while the current round is unfinished, and the date you last played. The row links back into the game; a **×** removes it, fading out first so the list doesn't jump.
- **Turn rings.** An unfinished game where you hold a seat gets a ring on its chip when it's your move, kept live by a light socket per such game so it reacts the moment your opponent plays. These sockets never count toward presence. See [architecture.md](architecture.md).

No hero images, no marketing, no footer clutter.

### Game (`/g/<code>`)

One screen, no scrolling on any target device:

- The wordmark on its own line at the top, linking home.
- The game's **name** beside the score — the code until it has one. Only the creator (black) gets it as a button; clicking swaps it for an inline input capped at the same 16 characters the server enforces, committed on Enter or blur, abandoned on Escape. The HUD shows the name the server actually granted, which may be a numbered variant.
- The 8×8 board, the centerpiece.
- A status line: whose turn / who won / who resigned / draw — with a dot in the turn player's color. Once **10 or fewer moves per side** remain before the 40-move draw, it gains a quiet suffix: "Your move · draw in 6".
- Score for the link's lifetime (black n — red n), with presence pulses on the chips.
- **Resign** while a round is in progress (seated players only); **Rematch** in its place once the round is over.
- A **Share** affordance (copy link) so inviting the second player is one tap, and a **Leave** action back to the landing page.
- Theme toggle, small and out of the way.

Spectators see the same screen minus move affordances, Resign, and the rename button.

### Resign

- An ordinary button beside Leave and Copy link, with red text — destructive, so it reads as such, but never styled as a primary action.
- **Two taps, inline.** The first tap turns it into "Confirm resign?", filled red, for ~3s; a second tap inside that window appends `resign`; otherwise it reverts. No modal — this is the only confirmation in the app, and it stays as light as the rest of the UI.
- Available on either player's turn, since the opponent may be away for a day.

## Board

- CSS Grid, 8×8, square cells, sized from the viewport's limiting dimension via `min()`/viewport units so the whole board always fits without scrolling.
- **Orientation:** each player sees their own pieces at the bottom, moving up — red's board is black's rotated 180°. Spectators see black at the bottom. A dark square sits in each player's bottom-left corner, as standard.
- No coordinates or square numbers on screen. The 1–32 notation is the log's business only.
- **Squares:** two muted neutrals from the theme — a warm off-white and a soft stone gray in light mode, two close charcoals in dark mode. No wood, no green felt; the board should be as quiet as everything around it.
- **Pieces:** discs with subtle depth, matching the family look of the pieces in the sibling 4-in-a-row game. Red is a clear warm red. Black is a deep charcoal with a thin light rim, so it reads on dark squares in both themes — the rim also means pieces never rely on color alone.
- **Kings:** a small inline-SVG crown on the piece, in the piece's contrast color. No stacked discs; they read as clutter at phone size.
- **Overlays** — selection, destination markers, the last-move trail, capture ghosts — all use one neutral accent at different strengths, never a seat color, so they can't be confused with pieces.

## Making a move

Tap the piece, then tap where it goes:

1. **Movable pieces.** On your turn only pieces with a legal move respond. When a capture is mandatory, that's only the pieces that can capture, and those carry a subtle cue so "why won't this one move?" never comes up.
2. **Select.** Tapping a movable piece selects it and marks its legal destinations: a small **dot** for a plain move; a **ring** for a capture landing, with a faint marker on the piece that would be taken. Tapping another of your movable pieces switches the selection; tapping the selected piece again, tapping an empty non-destination square, or pressing Escape deselects.
3. **Multi-jumps are tapped hop by hop.** After each hop the piece sits on its landing square, the jumped piece pops (see [Animation](#animation)), and the markers move to the next legal landings. Every hop is an explicit tap, even when only one continuation exists. You can't stop early — the rules require finishing the jump.
4. **Rewind.** Mid-jump, Escape or tapping the starting square rewinds the whole path; popped pieces fade quickly back in. Nothing has been sent, so it costs nothing.
5. **Send.** The move is appended the moment its path is complete. No confirm.
6. **Keyboard.** Arrow keys move a visible focus ring across the dark squares; Enter or Space acts as a tap.
7. **No drag-and-drop.** Tap-tap works for mouse and touch alike, and dragging through a multi-jump is awkward on a phone.

## Showing the last move

The opponent may have moved last night, so the board must answer "what just happened?" at a glance:

- **Pulse:** the piece that moved last pulses on its landing square, the same animation and timing as the sibling 4-in-a-row game's last disc, until the next move.
- **Trail:** a thin, faint outline on each square of the move's path — the starting square and every landing square. Outlines only; no connecting lines.
- **Capture ghosts:** each square where a piece was captured shows a faint hollow outline of that piece. This is the part that answers "what did I lose?"
- **Clearing:** while the player to move has a piece selected, the trail and ghosts hide to keep the board readable; deselecting brings them back. They clear for good when the next move lands. The pulse is unaffected by selection. The opponent and spectators keep the full trail until then.
- **No replay.** Opening a game never re-animates the last move — the trail tells the story without motion.

## Responsive targets

- **iPhone (portrait):** board spans nearly full width; status and score stack above/below. Everything reachable one-handed.
- **iPad / desktop:** board comfortably centered with whitespace; controls beside or below the board, never crowding it.
- Test at minimum: iPhone-class (~390pt wide), iPad-class (~820pt), and a desktop window (~1200pt+), portrait and landscape on the touch sizes.

## Theming

- Light and dark themes, as CSS custom properties on `:root`.
- Default follows `prefers-color-scheme`; if it can't be determined confidently, default to **light**.
- A manual toggle overrides the system setting and persists in localStorage; the stored choice wins on later visits.
- Both piece colors must hold clear contrast against both square colors in both themes.

## Animation

Restrained during play, with one deliberate exception when a round ends. Animation exists to communicate — and captures are allowed to be a little fun.

- **Slide:** a moving piece slides diagonally hop by hop, ~150–200ms per hop, with a brief pause between hops so a double jump reads as two jumps. Applies to live opponent moves and to each hop as you tap it. Your own move does not animate again when the server confirms it.
- **Capture pop:** each captured piece pops the moment the jumper passes over it — swelling to ~120% over the first ~90ms (ease-out), then shrinking to ~80% while fading out over the rest of ~280ms (ease-in). A quick inhale and gone. The ghost settles in after. The constants live in one place in `public/app.js`, tuned by eye.
- **Crowning:** a crown fades onto the piece with a single small scale pop.
- **Pulse:** the last-moved piece, as above; the scoreboard chips pulse while their player is connected.
- **History is never animated.** Opening or resyncing a game renders the current position immediately; only new events animate.
- Theme switches and presence changes transition briefly or not at all.
- **Reduced motion** (`prefers-reduced-motion`): pieces appear in place, captured pieces vanish and their ghosts appear, crowns appear without the pop, the last-move pulse becomes a static ring, and the celebration keeps its verdict and emoji fading in place with no growth, fall, or paint.

Nothing else moves.

### Celebration

Carried over from the sibling 4-in-a-row game unchanged in behavior: one full-viewport layer over everything, an emoji centered on the board, a verdict title above it, and — for a win — permanent paint splatters until dismissed. Timings and constants live in `createCelebration()` in `public/app.js`.

- **Trigger:** once per round, only when the round ends *live* in front of you, ~280ms after the final piece lands (after the last capture pop). Opening or resyncing a finished game shows the board, never the moment.
- **Per outcome:**
  - **Win** — "You win", 🏆 swelling up, paint splatters over a 50% scrim. Also what the opponent of a resigner sees.
  - **Loss** — "You lose", 😞 falling onto the board over an 85% scrim. No paint.
  - **Resigned** — the loss treatment, titled "You resign".
  - **Draw** — "Draw", 🤝 slamming in over an 85% scrim. No paint. Fires for the 40-move draw.
  - **Spectating a win** gets the winner's treatment, retitled to name the winner ("Black wins", "Red wins").
- **Paint, density, title sizing, cost:** as in the sibling game — splats accelerate over ~3s, density scales to the viewport (one dot per ~142 CSS px², floored at 1800, capped at 4300), the loop stops once the last splat settles, and the title is measured so it never overflows.
- **Dismissal** is a tap, click, Escape, Enter or Space; the field dissolves dot by dot in ~450ms. Either player's dismissal clears it for everyone at the game over the `dismiss` signal; a spectator's clears only their own screen.

The paint splatter effect is our own canvas implementation, inspired by [confetti.ts](https://github.com/LoaderB0T/confetti.ts) (MIT) but sharing no code with it — this project ships zero third-party assets.

## Miscellaneous

- The page works with no opponent connected — it's an async game; the UI should feel complete, not "waiting", when playing alone against silence.
- Typeface: Nebula Sans, self-hosted in `public/fonts/` (SIL OFL, license bundled) with a system-font fallback stack. Zero third-party requests.
- Icons: a simple checkers disc in the same family as the sibling game's set — SVG favicon, PNG sizes, maskable and dark variants, apple-touch-icon.
- Site-wide `X-Robots-Tag: noindex, nofollow` and the security headers live in `public/_headers`.
- The domain appears nowhere in markup, script, or styles.
