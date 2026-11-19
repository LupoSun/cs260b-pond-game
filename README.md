# Pond Game

A comic-style multiplayer game where a **team shares one swimming creature**. Each person holds a phone and paddles a single limb with a short seated sweep: hold, stroke, release. The rest of the room watches the shared display.

Teams of 4–6. At most 30 players. The phone recognizes the motion locally; the server owns the clock, scores, and seats.

![Five teams racing toward a checkered finish on the shared display](docs/screenshots/race.png)

## How it plays

1. Players enter a nickname and the team number they were given, are handed a random emoji as their badge, enable motion, hold still to calibrate, then practice a few strokes.
2. The shared display shows each creature with every player's emoji and nickname on their own paddle, and which paddles are live, calibrated, or still learning. Practice sweeps show up on the team's card as they happen.
3. **Game 1** is a straight race down parallel lanes. A creature is fast only when its limbs stroke at the same moment: the more limbs in sync, the faster. The race keeps going after the first finisher and ends when the last creature is home or time is up.
4. **Game 2** (optional) is open water with steering and collectibles worth different points: glow seeds 100, golden bugs 300, and a rare pond star 1,000. A big live scoreboard sits beside the water.
5. A leaderboard closes the session.

Each game has an unscored prep round first, and two dedicated discussion screens sit around Game 1.

A player keeps the same team, limb, and movement for the whole session. Disconnecting does not give the rest of the team extra power.

![Lobby with join QR code and five team creatures](docs/screenshots/lobby.png)

*Join from the projected QR code. Only teams that have players appear, and the layout resizes around them.*

![Training grid with five creatures and per-limb success marks](docs/screenshots/training.png)

*Training: each accepted stroke flashes on that paddle and leaves a checkmark, so you can see who still needs a hit.*

## Surfaces

| Route | Who | What |
| --- | --- | --- |
| `/play` | Players | Phone controller: join, calibrate, hold-to-paddle |
| `/screen` | The room | Read-only shared display (guide, lobby, training, games, discussion, leaderboard) |
| `/control` | Host | Passcode-protected console for phases, seats, and recovery |
| `/lab` | Host / debug | Standalone sensor check, no game propulsion |

The shared display cannot issue host commands.

## Quick start

```bash
npm install
cp .env.example .env
npm run build
npm run typecheck
npm test
npm run dev
```

Then open:

- Players: `http://127.0.0.1:3000/play`
- Shared display: `http://127.0.0.1:3000/screen`
- Host console: `http://127.0.0.1:3000/control`

Phone motion APIs need a top-level **HTTPS** origin, so local `http://127.0.0.1` is fine on a laptop browser and not enough for real phones. For phones, put the server behind HTTPS (Caddy, Nginx with TLS, or a WebSocket-capable tunnel such as Cloudflare Tunnel). `npm run tunnel:quick` starts a Cloudflare Quick Tunnel to `http://127.0.0.1:3000`.

During UI work you can also run `npm run dev:client` (Vite on port `5173`, proxying `/socket.io` and `/api`).

## Host a session

Open `/control`, sign in with `HOST_PASSCODE`, and set the universal min/max team size (default 4–6). Teams are created as people join; you do not pre-build a roster. Put `/screen` on the projector and hand out team numbers.

The phase picker lists the session in running order. Pick a step and press **Load Phase**; steps with a round also need **Start**. You can load any step at any time, repeat one, or skip Game 2.

| # | Step | Planned | What the room sees | You press |
| --- | --- | --- | --- | --- |
| 1 | Explanation and joining | 4 min | How-to-play page, revealed a step at a time. A fresh session opens on its first card, The Game. The join QR comes last. | **Next** in panel 3 for each step; **Hide Guide** shows the lobby |
| 2 | Training | 2 min | Press / Move / Release how-to and lock-rotation reminder on the left, team cards on the right. Practice sweeps animate live. **Join QR** in the header opens the code for latecomers. | Load, **Start** |
| 3 | Game 1 Prep | 3 min | Lanes, no score. Creatures lap the course. The sync rule is not announced. | Load, **Start** |
| 4 | Discussion: What Makes You Fast? | 2 min | Two prompts. Let the class work out the rule. | Load |
| 5 | Game 1 | 4 min | Straight race after a 3-second countdown. Ends when the last creature is home or the clock hits zero. | Load, **Start** |
| 6 | Discussion: After Game 1 | 2 min | Three prompts tied to the Won et al. reading, plus Game 1 placements. | Load |
| 7 | Game 2 Prep | 3 min | Open water, steering with real items to chase. Points show as practice and are not kept. | Load, **Start** |
| 8 | Game 2 | 5 min | Scored harvest with a live scoreboard. Ends when the clock hits zero. | Load, **Start** |
| 9 | Leaderboard | — | Combined standings and session highlights, with a QR code to this repository on the left. | Load |

The planned times add up to 25 minutes.

- **Explaining the game.** The guide shows only what you have revealed. In panel 3, **Next** adds one thing at a time: The Game (already showing), Step 1 without the QR code, Step 2, Step 3, and finally the QR code and address. **Back** takes the last one away again, and you can click any step in the list to jump to it. Nothing appears by itself. Hiding the QR code does not stop a phone that already has the address from joining; use **Lock New Admission** for that.
- **The clock starts when you Load a step**, and shows on the classroom display and in Mission Control. Staging time and the 3-second countdown count, so a slow start shortens a game rather than the class running late. For the how-to-play, press **Load Phase** with step 1 (Explanation) selected: the guide starts from its first card and the 4-minute clock starts, shown at the top right of the guide. If you skip that, the clock starts when you reveal the guide's second step, when the first player joins, or when you press **Start Clock**, whichever comes first.
- **At zero, Game 1 and Game 2 end. Nothing else does.** In every other step the clock turns red, shows **Over**, and counts into the minus until you load the next step. Prep rounds keep running until you press **End Round** or load the next step.
- The clock keeps running through **Pause**: it measures class time. A game paused when its time runs out ends when you resume it.
- In panel 1 you can change the planned time of the step on screen or restart its clock. During a live game that is how you give it more time.
- If you press **Start** on a game whose time is already used up, it starts but will not end by itself, and Mission Control tells you so. Press **Restart Clock** to give it a full allowance, or end it yourself.
- **Team cards.** [`docs/print/team-cards.pdf`](docs/print/team-cards.pdf) is one Letter page of eight cut-out cards, Teams 1–8, each with the team's number, name, color, and the three join steps. Hand one to each group so they know which number to type.
- Training has to be **started** before sweeps count or animate on the grid.
- A player who finished their three practice sweeps but never tapped **Enter Controller** is moved into the controller automatically when you load any step after Training. Players short of three are told the class has moved on and can tap **Skip**.
- Game 1 does not stop at the first finisher.
- Discussion and Leaderboard have nothing to start or end. Load the next step when the room is ready. Plain **Pause** still works inside Training and rounds.
- **Limbs come and go with players.** A phone that drops off keeps its limb for 5 seconds (shown as offline), then the limb leaves the creature and the others are renumbered. When that phone reconnects, the limb grows back in its old place with the same sweep. Someone who lost their page can simply join the team again as a new limb. Mission Control lists departed players as **Away**.
- **Catch-up items in Game 2.** Once the scores differ, valuable items appear near whichever team is last: a pond star lands a few seconds' swim from them, a golden bug a little further out, and seeds anywhere. While the scores are level nothing is steered.
- **Player emoji.** Each player gets a random emoji that no one else in the session has. It leads their nickname on their paddle, on their phone, and in the Mission Control roster, and stays with them through reconnects.
- **Background music** is the switch in panel 3, with a **volume slider** under it that the room hears as you drag (70% to begin with). It plays from the classroom display only: a lounge loop while joining and between rounds, a mid-tempo loop during training and prep rounds, a fast ska loop during Game 1 and Game 2, a short fanfare when the leaderboard appears, and nothing during discussions. The files are in [`public/music/`](public/music/); to change a track, replace the file of the same name and rebuild. Browsers will not play sound until the display's page has been clicked or a key pressed on it, and no page can get around that. One click anywhere on the display at any time is enough, even before you switch music on. If nobody has touched it, the display shows "Click anywhere on this screen to start the music" on top of everything, the guide included.
- **iPhone "Undo Typing" pop-up.** Shaking an iPhone can bring up Undo Typing. To prevent this, the iPhone page reloads itself once right after joining, which is expected: with nothing typed, there is nothing to undo. Players are not asked to change any setting. If the box still appears on someone's phone, they can tap Cancel, or switch it off under Settings → Accessibility → Touch → Shake to Undo.
- The leaderboard keeps the last completed run of each game until that game is finished again or the session is cleared. Points per game are the number of teams minus your rank, plus 1; ties share a rank.

Useful recovery (none of these should be “clear the whole session” mid-game):

- **Release Hold** — unstick one held paddle
- **Recalibrate** — that phone only, same team/limb/gesture
- **Reset Practice** — clear practice checkmarks, keep seats
- **Reset Current Round** — positions, timer, and items, keep people
- **Clear Entire Session** — evicts everyone; needs explicit confirmation

Restarting the Node process also wipes the in-memory session. Phone reconnects during a live session resume the same seat; after more than 5 seconds away the limb has been released and grows back on return.

## Configuration

Copy [`.env.example`](.env.example) to `.env` (never commit `.env`):

| Variable | Purpose |
| --- | --- |
| `PORT` / `HOST` | Local bind address (default `127.0.0.1:3000`) |
| `HOST_PASSCODE` | Mission Control sign-in; required when `NODE_ENV=production` |
| `PUBLIC_BASE_URL` | HTTPS origin printed on the join QR code |
| `ENABLE_DEV_SIM` | Keep `false` for real sessions so synthetic test buttons stay hidden |

A systemd unit template lives at [`deploy/cs260b-pond-game.service.example`](deploy/cs260b-pond-game.service.example).

## Development

Tested on Linux (`7.0.0-43-generic`) with Node.js `v22.22.1` and npm `9.2.0`.

Pinned runtime: `express@4.21.2`, `socket.io@4.8.1`, `socket.io-client@4.8.1`, `react@19.0.0`, `react-dom@19.0.0`, `qrcode@1.5.4`, `@fontsource/bangers@5.3.0`, `@fontsource/comic-neue@5.3.0` (fonts are bundled; no font CDN).

Pinned toolchain: `typescript@5.7.3`, `vite@6.2.0`, `vitest@3.0.7`, `tsx@4.19.3`.

```bash
npm test
npm run rehearse:load
```

`npm test` covers recognizer rejections, seat caps, reconnect, stroke dedup, pause/resume freshness, limb-count propulsion, disconnect power, the two network presentation modes awarding the same propulsion, sync-scaled speed in Game 1, the race continuing past the first finisher, prep laps, the discussion phases, leaderboard scoring, limbs being released and growing back, item kinds and points, items in Game 2 Prep, the music switch and volume, catch-up item placement, player emoji, the stepped guide, and the section clock (planned times, starting on load, ending the two scored games at zero and nothing else, running negative elsewhere, and surviving pause and reset). The load rehearsal measures 30 player sockets plus host and display.

### Known limits

- Real iPhone Safari and Android Chrome sensor behavior still needs to be tuned on device. Synthetic traces are not physical-phone proof. `/play` can expose labeled **Directional Tilt** and **Touch Swipe** fallbacks if a handset cannot do linear sweeps.
- Game 1's sync rule uses engineering defaults that have not been tuned with real phones in a room: strokes within 350 ms of each other count as together, and speed scales from 0.35× (alone) to 1.5× (whole team). Sync is judged by when the server accepts each stroke, so network jitter eats into the window. The values live in `GAME_DEFAULTS` in [`src/shared/constants.ts`](src/shared/constants.ts).
- A team with a disconnected player cannot reach full sync for the 5 seconds their limb is held. After that the limb is released and the remaining players' strokes are each worth more, exactly as on a team that joined at that size. A phone that locks its screen for longer than 5 seconds loses its limb until it wakes.
- The iPhone reload-after-join that reduces "Undo Typing" pop-ups is untested on a physical iPhone. A web page cannot disable Shake to Undo.
- The background music was chosen without listening to it. The four tracks were picked from Freesound by download counts, ratings, and descriptions, then measured for tempo, whole-bar length, level, and a clean join at the loop point. Whether they suit your room is for you to judge; the sources are in [`public/music/CREDITS.txt`](public/music/CREDITS.txt).
- The catch-up distances for items (a star 110–230 arena units from the last-placed team, a golden bug 230–420) are untuned and untried with a class.
- Player emoji were checked for rendering in Chromium on Linux only. iPhone and Android draw their own versions, which have not been looked at.
- Item point values (100 / 300 / 1,000), how often each kind appears, and the 5-second limb grace period are untuned defaults in [`src/shared/constants.ts`](src/shared/constants.ts).
- Game 1's four minutes include staging and the countdown. In synthetic runs poorly coordinated teams needed about 2:30–3:00 of play to finish, so a slow start can leave some teams short of the line; they are ranked by distance. Untested with a real class.
- The prep rounds do not end by themselves. If nobody presses **End Round** or loads the next step, they keep running with the clock in the red.
- The planned times return to the defaults when the server restarts.
- The sentence on The Game card linking the activity to the reading ("homuncular flexibility … remapped onto a limb your own body does not have") is draft wording awaiting confirmation, in [`src/client/views/ScreenView.tsx`](src/client/views/ScreenView.tsx).
- The discussion prompts are draft wording awaiting confirmation, in `DISCUSSION_PROMPTS` in [`src/client/views/ScreenView.tsx`](src/client/views/ScreenView.tsx).
- iPhone Safari does not give web pages general Taptic Engine access. Essential state is always visual; haptics and audio are optional.
- Creatures, water, and UI chrome are procedural comic art (Canvas + CSS), not final illustrated assets.
- Session state lives in server memory.

Implementation details: [`CS260B_Pond_Game_Implementation_Spec.md`](CS260B_Pond_Game_Implementation_Spec.md).
