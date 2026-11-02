Make a small arcade game that runs in the browser, of your own design: invent something fun rather than copying an
existing game. It's a static web page in this repository, `index.html` with CSS and JavaScript, drawn on a `<canvas>`,
with no frameworks, no build step and no dependencies. It must work when the folder is served by any static web server
(ES modules are fine), with nothing loaded from the internet.

**Playing**

- Players move left and right, with the arrow keys and with on-screen buttons (below). Anything else the game needs is
  up to you.
- Scoring rewards staying alive: the score keeps rising while a game is running, even if the player does nothing, and
  can rise faster for playing well.
- A game ends sooner or later. If the player does nothing at all, it must end within 60 seconds.
- Best scores are kept in `localStorage`: show the best one, and a short table of high scores after a game.
- It should look and feel good, be easy to pick up, work on a phone as well as a desktop, and run without errors.

**What the page must offer** (automated checks rely on these)

- `document.body` has `data-state` set to the game's state at all times: `ready` before the first game, `playing`,
  `paused` or `over` (the game has ended). The page opens in `ready`.
- Pressing Space, or clicking a button with the accessible name "Start", starts a game from `ready`, and a new game from
  `over`. A new game starts from a score of 0.
- Pressing P, or clicking a button with the accessible name "Pause", pauses a running game and resumes a paused one.
  While paused, nothing moves and the score holds still.
- An element with `data-score` shows the current score as a whole number, kept up to date while playing; it keeps the
  final score once the game is over.
- An element with `data-best` shows the best score so far as a whole number (0 when there is none), and still shows it
  after a reload.
- The canvas has a `data-player-x` attribute: the player's horizontal position as a number (in any units; larger means
  further right), kept up to date while playing.
- On-screen buttons with the accessible names "Left" and "Right" move the player for as long as they are held down,
  whether with a finger, a mouse or a pen (use pointer events), at least 44 × 44 px each.
- On a 375 × 812 phone screen, the canvas is at least 300 × 300 px, and the whole canvas, the score and the Left and
  Right buttons are all on screen at once without scrolling. On a 1280 × 800 desktop screen, the whole canvas is on
  screen and at least 400 px on its shorter side. The page never scrolls sideways.

**Code**

Keep the game's rules in pure functions in `src/*.js`, separate from the DOM and canvas code: at least updating the game
state over time, scoring and collisions. Test them with `node --test`. `npm test` runs the tests.
