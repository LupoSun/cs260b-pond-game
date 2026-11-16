# CS260B Shared-Body Pond Game

A classroom multiplayer game about learning unfamiliar avatar controls, accompanying discussion of [*Homuncular Flexibility in Virtual Reality* — Won et al. (2015)](https://doi.org/10.1111/jcc4.12107). Teams of 4–6 participants collectively operate one swimming pond creature, with each seated participant using a phone to control a single paddle through one assigned, compact motion.

> **Educational Context:** Unlike Won et al. (2015), which investigates individual motor learning on altered avatar bodies, this activity distributes limbs across multiple people and introduces interpersonal coordination.

---

## Current Project & Validation Status

| Subsystem | Status | Notes |
| --- | --- | --- |
| **Gate A — Sensor Laboratory (`/lab`)** | Implemented; synthetic tests passing | **Physical-phone validation gate OUTSTANDING** on real iPhone Safari and Android Chrome over HTTPS. |
| **Gate B — One Phone → One Live Limb** | Implemented & verified | Local classification, server acceptance, live preview & completed-stroke modes, reconnect & pause safety. |
| **Gate C — Team Training & Mission Control** | Implemented & verified | Universal `[minTeamSize, maxTeamSize]` bounds on `/control`; dynamic joined-only lobby & training cards that resize/relayout (`1×1`, `2×1`, `2×2`, `3×2`, `4×2`...); dynamic limbs (`1..6` per creature, ≤30 players total); scoped resets. |
| **Gate D — Core Straight Race** | Implemented & verified | Normalized `1/N` propulsion, 3s countdown, active-only timer, lanes, finish/timeout ranking. |
| **Gate E — Optional Free-Water Harvest** | Implemented & verified | Bank-normalized turning, 20s unscored practice, authoritative 2D body-radius item contact & respawn. |
| **Artwork & Assets** | Procedural comic-style placeholder art | American comic / pop-art interface on all surfaces (ink outlines, halftone, speed lines, starbursts, outlined lettering; see [`PRODUCT.md`](PRODUCT.md) and Specification Section 11.1). All 8 modular creature layers (shadow, wakes, articulated paddles, center tail, localized success burst, body/face, team accessories, upright Limb-ID pills) are drawn procedurally on HTML5 Canvas; final reviewed illustration assets pending. Checked in a desktop browser with synthetic players only, not on physical phones or a projector. |

---

## Tested Runtime & Pinned Dependencies

Tested on Linux (`7.0.0-43-generic`):

- **Node.js:** `v22.22.1` (LTS `>=22.0.0`)
- **npm:** `9.2.0`
- **Pinned runtime packages:** `express@4.21.2`, `socket.io@4.8.1`, `socket.io-client@4.8.1`, `react@19.0.0`, `react-dom@19.0.0`, `qrcode@1.5.4`, `@fontsource/bangers@5.3.0`, `@fontsource/comic-neue@5.3.0` (fonts are bundled and self-hosted; no font CDN is contacted)
- **Pinned build/test toolchain:** `typescript@5.7.3`, `vite@6.2.0`, `vitest@3.0.7`, `tsx@4.19.3`

---

## Quick Start (Local Development)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build client and server bundles:**
   ```bash
   npm run build
   ```

3. **Run automated unit, integration, and load tests:**
   ```bash
   npm run typecheck
   npm test
   npm run rehearse:load
   ```

4. **Start local server:**
   ```bash
   cp .env.example .env
   # Set HOST_PASSCODE in .env for production, or run in development:
   npm run dev
   ```
   When running Vite with hot reload during UI work, run `npm run dev` (port `3000`) alongside `npm run dev:client` (port `5173`, which proxies `/socket.io` and `/api`).

---

## Browser Surfaces

| Route | Surface | Purpose |
| --- | --- | --- |
| `/play` | **Participant Phone Controller** | Enter facilitator-assigned team number, enable motion sensors, capture stationary calibration, practice 3 sweeps, and hold-to-paddle. |
| `/screen` | **Classroom Display** | Read-only public projector view: join QR code, 6-team training grid, straight swim race, free-water harvest, discussion pause overlay, and rankings. |
| `/control` | **Mission Control** | Passcode-protected facilitator console: team capacities, admission lock, phase staging/start/pause/discussion, network mode toggle, per-player diagnostics, and scoped resets. |
| `/lab` | **Gate A Sensor Laboratory** | Standalone phone sensor verifier with capability report, stationary calibration, live processed `screenX`/`screenY`/`|XY|` trace oscilloscope, and rejection codes. |

---

## Deployment on Your Linux Server (SSH + HTTPS)

Phone browsers (`DeviceMotionEvent` / `DeviceOrientationEvent`) **require a top-level HTTPS origin**. Run the Node.js service locally on your Linux machine and expose it through an HTTPS reverse proxy or WebSocket-capable tunnel (such as Caddy, Nginx with TLS, or Cloudflare Tunnel).

1. **On the Linux server over SSH:**
   ```bash
   git clone <YOUR_REPO_URL> cs260b-pond-game
   cd cs260b-pond-game
   npm ci
   npm run build
   ```

2. **Configure `.env` (never commit `.env`):**
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   - `PORT=3000`
   - `HOST=127.0.0.1`
   - `HOST_PASSCODE=<strong-facilitator-passcode>` (required when `NODE_ENV=production`)
   - `PUBLIC_BASE_URL=https://<your-public-https-domain>`
   - `ENABLE_DEV_SIM=false` (keeps developer synthetic input buttons disabled in classroom play)

3. **Keep running after disconnecting SSH (`systemd`):**
   Copy [`deploy/cs260b-pond-game.service.example`](deploy/cs260b-pond-game.service.example) to `/etc/systemd/system/cs260b-pond-game.service` (replacing `<LINUX_USER>` and `<REPO_ABSOLUTE_PATH>`), then enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cs260b-pond-game
   sudo systemctl status cs260b-pond-game
   ```

4. **Verify health & phone reachability before class:**
   - Local health check: `curl -s http://127.0.0.1:3000/api/health`
   - Public HTTPS check from a real phone on classroom Wi-Fi/cellular:
     1. Open `https://<your-public-https-domain>/lab` on one **iPhone (Safari)** and one **Android phone (Chrome)**.
     2. Tap **Enable & Check Sensors** → confirm `status: ready` and numeric sample rate (`Hz`).
     3. Tap **Capture Stationary Calibration**, then perform 10 seated sweeps per gesture and 20 negative trials (stationary hold, quick tap, opposite sweep, wrist tilt) per Specification Section 14.1.
   - **Intentional restart note:** Classroom state is authoritative in server memory. Restarting `cs260b-pond-game` creates a fresh `sessionId` and clears seated players, while normal phone Wi-Fi drops/reloads reconnect seamlessly to the same seat via `resumeToken`.

---

## Facilitator Classroom Runbook

1. **Preflight (Before Students Scan):**
   - Open `/control` on your laptop and sign in with `HOST_PASSCODE`.
   - Set your universal **Min** and **Max Team Size** in **Section 3** (default: `4–6` players per team; editable `1–6` at any time). You do not need to pre-create teams manually — teams appear and size their paddles automatically as students join!
   - Click **Open Classroom Display ↗** (`/screen`) and drag it to the classroom projector (`1920 × 1080`). Before anyone joins, `/screen` displays a centered QR join stage; as teams join, only joined teams appear and their cards dynamically resize and relayout across the grid.

2. **Joining (~2 min):**
   - Hand out or announce each group's **Team Number (1–6)**.
   - Students scan the projected QR code (`/play`), enter their assigned team number, tap **Enable Motion**, hold steady for stationary calibration (`0.75s`), and complete 3 practice sweeps.
   - Watch **Team & Limb Readiness Inspection** in Mission Control: **Online**, **Sensor Status**, **Calibrated**, and **Practiced** are tracked separately so you can help any stuck student immediately.

3. **Training (~2 min) & Discussion Pause (1–2 min):**
   - Select **Training (Team Card Grid)** → **Load Phase** → **Start Training**.
   - Each recognized stroke briefly highlights that specific paddle green on the projected card and leaves a persistent `✓` badge without hiding teammates who still need help.
   - Click **Pause for Discussion** to freeze paddles and show the guided CS260B discussion prompts on `/screen`.

4. **Game 1 — Straight Pond Race (1–1.5 min):**
   - Select **Game 1: Straight Swim Race (90s)** → **Load Phase**.
   - Click **Start Round** (if a seat is empty or uncalibrated, Mission Control warns you and lets you explicitly override).
   - A shared **3-2-1** countdown runs, locking new admission while allowing existing players to reconnect. Teams race down parallel lanes; results rank finishers by server time and unfinished teams by distance.

5. **Optional Game 2 — Free-Water Steering & Pond Harvest:**
   - First load **Game 2 Prep: Free-Water Practice (20s)** → **Start** so teams feel how left-bank paddles turn right and right-bank paddles turn left.
   - Then load **Game 2: Scored Pond Harvest (90s)** (editable to `60s`) → **Start Round** to reset positions and spawn collectibles.

6. **Scoped Recovery Controls (Never Use Clear Session Mid-Activity):**
   - **Release Hold (1 player):** Clears a stuck held limb without touching calibration or scores.
   - **Recalibrate (1 player):** Prompts that specific phone to re-run stationary calibration while keeping the same team, limb, and gesture. (Requires pausing first if in a scored round.)
   - **Reset Practice (Team / All):** Clears practice checkmarks while keeping seats and calibration.
   - **Reset Current Round to Ready:** Resets positions, timer, and items for the current game without evicting players.
   - **Clear Entire Session:** Evicts all players and creates a new session (requires explicit confirmation).

---

## Automated Verification & Load Rehearsal Summary

- **Unit & Integration Suite (`npm test`):** 22 passing tests across `tests/recognizer.test.ts`, `tests/serverAndGame.test.ts`, and `tests/socketIntegration.test.ts` covering:
  - Stationary hold rejection, quick-tap rejection, all 6 cardinal/diagonal sweeps (with both `acceleration` and gravity-compensated `accelerationIncludingGravity`), opposite-sweep braking-lobe rejection, return-while-released immunity, single-stroke-per-press latching, button-press transient immunity, pure-tilt rejection, and `30/60/120 Hz` rate independence.
  - 30-player seat cap, atomic last-seat join, refresh/tab-supersede reconnect, stroke deduplication, `inputEpoch` pause/resume stale-stroke rejection, `4/5/6`-limb cycle normalization, disconnect power invariance, `continuous` vs `stroke_events` scoring equivalence, simultaneous item tie-breaking, and unauthorized host command rejection.
- **30-Player Load Rehearsal (`npm run rehearse:load`):** Measured with 30 concurrent player WebSocket connections + 1 host + 1 display:
  - `continuous` mode (`~600 previews/sec` aggregate): `0 ms` added RTT → `p95 = 3.4 ms`; `100 ms` RTT (`±20 ms` jitter) → `p95 = 58.5 ms`; `250 ms` RTT (`±35 ms` jitter) → `p95 = 140.5 ms`; `500 ms` RTT (`±50 ms` jitter) → `p95 = 272.8 ms`; host pause command turnaround stays `< 2 ms`.
  - `stroke_events` mode reduces preview message traffic to `0 previews/sec` while achieving equivalent team progress.

---

## Known Limitations & Assumptions Requiring Real-Device Validation

1. **Physical Phone Sensor Gate (Mandatory Next Step):** Synthetic traces and automated tests verify mathematical invariants, **not** ergonomic comfort or browser sensor quirks on real phones. Run `/lab` over HTTPS on an actual **iPhone (Safari)** and **Android phone (Chrome)** to tune `RECOGNIZER_DEFAULTS` in [`src/shared/constants.ts`](src/shared/constants.ts) (`directionToleranceDeg`, `minOnsetThresholdMps2`, `minForwardVelocityImpulseMps`, `pureTiltRejectDeg`). If physical linear sweeps prove unreliable on a target handset, `/play` includes explicit, Mission-Control-visible **Directional Tilt** and **Touch Swipe** fallbacks.
2. **iPhone Web Haptics:** iOS Safari does not expose general programmable `navigator.vibrate()` / Taptic Engine APIs to web apps. Per Specification Section 8, all essential states are communicated visually and textually (with optional Web Audio tones), and Android vibration fires strictly *after* stroke recognition has latched so vibration never contaminates accelerometer readings.
3. **Placeholder Procedural Artwork:** Creatures, paddles, accessories, lanes, and collectibles are currently rendered as modular comic-style Canvas vector layers (`src/client/pondRenderer.ts`), and the DOM interface uses CSS and inline SVG only (`src/client/styles.css`, `src/client/components/ComicBurst.tsx`). This is placeholder art: it should be reviewed if bespoke illustrated sprite sheets are desired, and its legibility on real phones and the classroom projector is still unverified.
4. **In-Memory Session Persistence:** Reconnecting phones keep their seats across network drops, but restarting the Node.js server process clears in-memory session state.

See [`CS260B_Pond_Game_Implementation_Spec.md`](CS260B_Pond_Game_Implementation_Spec.md) for the complete specification and [`AGENTS.md`](AGENTS.md) for contributor rules.
