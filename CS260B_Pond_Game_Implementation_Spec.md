# CS260B Shared-Body Pond Game — Implementation Specification

Version: 0.5 · Prepared: 15 November 2026 · Revised: 18 November 2026

Status: implementation handoff; the game has not been implemented or validated on physical phones.

Revision 0.2 records design decisions the project owner made after playtesting: a how-to-play page that opens the session, a fixed running order with unscored prep rounds before both games, dedicated discussion phases in place of "pause for discussion", a leaderboard phase, a 7-minute default for both games, a straight race that ends only when the last creature finishes or time is up, and synchrony-based speed in the straight swim. Where this revision contradicts older wording elsewhere in the document, this revision wins.

Revision 0.3 records further decisions from the same owner's second playtest: creatures carry each player's nickname on their limb instead of a limb number, the training display reminds players to lock screen rotation in place of the join panel, the discussion before Game 1 has two questions, the discussion after Game 1 ties the experience to the Won et al. reading, and gestures are assigned at random (Section 7.2).

Revision 0.4 records decisions from the owner's third round of feedback: the three beats of a stroke are named **Press, Move, Release** on every surface and shown prominently on the phone and the training display; Game 2 Prep has items to collect; items come in three kinds with different points and different sizes of celebration; Game 2 has a large live scoreboard; optional background music is switched globally from Mission Control; iPhone's Shake to Undo is mitigated as far as a web page can; and creatures gain and lose limbs dynamically as players leave and return. The last item replaces the earlier rule that a disconnect never removes a limb, and with it the unqualified forms of two statements in `AGENTS.md` ("a player keeps the same … limb … throughout the activity" and "do not give a team more power because a participant disconnects"); Section 10.1 gives the rule that now applies.

Revision 0.5 records the owner's session plan and three related decisions. (1) The activity is planned as eight timed sections totalling 25 minutes (Section 3.1.1), and every section has a **section clock** that starts when the phase is loaded, counts down from the planned time, and turns red and runs negative when the section overruns. **Game 1 and Game 2 are the only phases the clock ends**: a scored game stops when its clock reaches zero. Every other section, including both prep rounds, is only paced by the clock and ends when the facilitator moves on. The clock starts at load, not at Start, because the owner needs it to keep the class on schedule. This replaces "both games default to 7 minutes" from revision 0.2: Game 1 now has 4 minutes and Game 2 has 5, each counted from load. (2) The background music is recorded loops chosen from Freesound under Creative Commons 0 instead of a tune synthesized in the browser (Section 8.1). (3) The phone no longer shows a tip about switching Shake to Undo off; the reload after joining is the whole mitigation (Section 6.1).

## 1. Read this first

Build a browser-based classroom activity in which teams collectively control a many-limbed swimming creature. Each seated participant uses a phone to control exactly one limb through one assigned, repeatable physical movement. The facilitator runs training and games from a private Mission Control interface. A separate classroom display shows every team's creature.

This document is self-contained. The implementation agent should not need the preceding conversation.

Terminology:

- **Confirmed requirement:** explicitly requested or agreed in the design conversation.
- **Implementation default:** a concrete recommendation that resolves an unspecified detail. Implement it as configurable where practical; it is not a claim that the user separately approved that exact value.
- **Validation gate:** something that requires observation or measurement before declaring it reliable.

Do not substitute a simulated sensor demonstration for a working phone controller. Development simulations are useful, but must be visibly labeled and separate from real participant input. Start with the physical-phone recognition spike in Section 15, then build the complete system.

### 1.1 Purpose and learning

The activity accompanies a CS260B discussion of *Homuncular Flexibility in Virtual Reality* by Won, Bailenson, Lee, and Lanier (2015). The experiential focus is learning an unfamiliar movement-to-avatar mapping and applying that learning to a task.

This is a classroom activity, not a replication of that paper. The paper studies individual control of altered avatar bodies; this game distributes limbs across people and therefore adds interpersonal coordination. Better race performance is not, by itself, evidence of body ownership or a changed body schema.

The activity should help students discuss:

1. How feedback helps someone learn a new control mapping.
2. How individual motor learning differs from collective coordination.
3. How changing the task changes the usefulness of an already learned body.

No accounts, grades, or formal human-subjects data collection are required.

### 1.2 Confirmed product requirements

| Area | Requirement |
| --- | --- |
| Participants | At most 30 players across teams (up to 6 players per team). Facilitator and display connections do not consume player seats. |
| Team body | One creature per team, with its number of controllable limbs determined dynamically by how many participants have joined that creature (one limb per joined participant). |
| Joining | One QR code; players enter a facilitator-assigned team number. Never silently place a player into another team. |
| Assignment | Each participant keeps the same team and assigned motion from onboarding to the end. The limb's position and number on the creature can change when a teammate's limb is released or returns (revision 0.4). |
| Input | Easy directional movements, including left-to-right, right-to-left, and diagonal sweeps. |
| Seated use | Keep movements compact and below approximately 50 cm. Small comfortable movements are the normal case. |
| Stroke cycle | Press and hold during the working movement; release while returning to the starting position. |
| Explanation | A how-to-play page on the classroom display opens the session. |
| Training | A checkerboard/grid of team cards on the classroom display. Each card contains its team's creature and live limb feedback, including sweeps a player makes during the phone's own practice step. A how-to panel sits on the left of the grid with the three beats of a stroke (Press, Move, Release) and a reminder to lock screen rotation; the join QR is one tap away for latecomers. |
| Recognition feedback | A successful movement causes visible feedback, such as a green highlight, and a small forward-swimming response. |
| First game | Straight swimming race to a finish line. A creature moves fast only when its limbs stroke at the same time: the more limbs in sync the faster, and unsynchronized strokes are penalized. The race does not stop when the first creature finishes; it ends when the last creature finishes or its section clock reaches zero. |
| Optional second game | Free-water steering and item collection, if time permits. |
| Prep rounds | Each game is preceded by an unscored prep round: lane practice before Game 1, steering practice before Game 2. |
| Discussion | Dedicated discussion phases, not a pause embedded in another phase: one between Game 1 Prep and Game 1 asking whether students have figured out what makes them move fast, and one between Game 1 and Game 2 Prep. |
| Leaderboard | A leaderboard phase shows the competition statistics of the session. |
| Game length | Game 1 has 4 minutes and Game 2 has 5, counted from the moment the phase is loaded (revision 0.5, Section 3.1.1). The two scored games end when that time runs out. No other phase ends on time. |
| Collection | An item disappears on contact and awards the collecting team that item's points. Items come in three kinds with different values. |
| Facilitator | Private Mission Control to operate phases, pause/resume, and reset specific state. |
| Network modes | Live limb updates and a lower-traffic completed-stroke mode; facilitator chooses a common mode between active rounds. |
| Visual direction | Animated American comic / pop-art pond: thick black ink outlines, halftone dot fills, speed-line and starburst accents, chunky outlined lettering, and a saturated blue, pink, yellow, orange, and red palette. This replaces the earlier painted 2.5D direction. |
| Devices | Modern iPhones and Android phones, subject to an actual browser sensor capability check. |
| Hosting | One Linux server managed over SSH; participants and classroom computer use normal web browsers. |
| Haptics | Provide additional haptic feedback where the browser permits it; essential feedback must work without vibration. |

### 1.3 Initial implementation defaults

- Universal minimum and maximum team size (`4–6` by default, editable `1–6` in Mission Control); teams are not pre-created manually, and instead spawn dynamically and size their paddles automatically according to who has joined within the configured `[minTeamSize, maxTeamSize]` range (up to the 30-player session cap).
- Mostly overhead world view with mild illustrative depth; game geometry remains two-dimensional.
- Training, like every section, shows the section clock and ends only when the facilitator moves on.
- Three-second shared countdown before either scored game.
- A section's planned time is editable from 10 seconds to 60 minutes at any moment. In a live scored game this moves the moment the game ends; anywhere else it changes only the clock. Course length is tuned so a team stroking in sync finishes the straight race in approximately 45–75 seconds. In synthetic runs poorly coordinated teams needed about 2:30–3:00 of play, which is close to what a 4-minute section leaves after staging and the countdown, so some teams may not finish; they are ranked by distance.
- Game 1 Prep: unscored lane practice in which creatures lap the course instead of finishing, planned at 3 minutes. Game 2 Prep: unscored steering with items to chase, planned at 3 minutes. Both run until the facilitator ends them or loads the next phase; their clocks never end them.
- Synchrony in the straight swim (Section 10.3): strokes from different limbs of one team accepted within 350 ms form a sync group; the propulsion multiplier rises linearly from 0.35 for a lone stroke to 1.5 when every joined limb is in the group. These three numbers are untested on physical phones and must be tuned in rehearsal.
- Leaderboard standings use placement points (Section 10.5).
- Discussion prompts follow the owner's direction (Section 5.4), but the exact sentences are draft wording until the owner confirms them (Section 16).
- All team creatures can overlap in free water; there are no creature-to-creature collisions.
- ~~Equal value for all collectible items.~~ Superseded in revision 0.4: items have different values (Section 10.4).
- Primary gesture candidate: short physical sweeps, recognized locally from motion signals. Directional tilts are an explicit development fallback, not an automatic replacement.
- Both network modes award exactly the same propulsion for the same accepted strokes. The difference is how often intermediate limb animation updates are sent.

## 2. System surfaces and roles

Implement three distinct browser surfaces backed by the same authoritative session.

| Surface | Suggested route | Intended device | Capabilities |
| --- | --- | --- | --- |
| Participant controller | `/play` | Phone | Join a specified team, enable sensors, calibrate, practice and perform the assigned movement, see own feedback. |
| Classroom display | `/screen` | Projector-connected computer | Read-only public view: QR joining, team training grid, race, collection arena, pause screen, results. |
| Mission Control | `/control` | Facilitator laptop/tablet | Authenticate, inspect readiness, configure teams, operate phases and timing, choose network mode, run scoped resets. |

Suggested routes are implementation defaults, not required URL spellings.

The classroom display must not expose private controls or authentication credentials. The facilitator should be able to open a preview of the classroom view without replacing Mission Control. All public views derive their phase from the server.

## 3. Session flow and phase control

### 3.1 Normal classroom sequence

1. Facilitator sets the universal minimum and maximum team size on Mission Control (default 4–6); team count and per-team sizes configure automatically as players join.
2. **Explanation.** A fresh session opens on the how-to-play page, which carries the join QR code and a readable short URL (Section 5.1). Hiding it reveals the lobby, where only teams that have joined are shown and their cards resize as more teams join.
3. Players enter their assigned team number, receive a limb, enable motion access, complete calibration, and begin their three practice sweeps.
4. **Training.** Facilitator loads and starts training. The display shows the Press / Move / Release how-to and a lock-your-rotation reminder on the left, and the team-card grid beside it. Practice sweeps, including those made in the phone's practice step, animate the corresponding limbs and generate green success feedback.
5. **Game 1 Prep.** Unscored lane practice. Teams swim laps and experiment; the synchrony rule is not announced.
6. **Discussion: What makes you fast?** A dedicated phase asking whether students have figured out what makes them move fast.
7. **Game 1.** Facilitator loads the straight race, starts the countdown, and runs the race. Display shows race results.
8. **Discussion: After Game 1.** A dedicated phase, with the Game 1 placements alongside the prompts.
9. **Game 2 Prep.** Short unscored steering practice in free water.
10. **Game 2.** Scored collection. Display shows collection results.
11. **Leaderboard.** Session standings and statistics (Section 10.5).

Mission Control lists these steps in this order. The order is a guide, not a lock: the facilitator can load any step at any time, repeat one, or skip the optional second game.

#### 3.1.1 Session plan and the section clock

The owner's plan (**confirmed requirement**, revision 0.5) divides the activity into eight sections totalling 25 minutes. These are the default planned times:

| # | Section | Phase | Planned time |
| --- | --- | --- | --- |
| 1 | Explaining and joining | Lobby, with the how-to-play guide | 4 min |
| 2 | Learning and training | Training | 2 min |
| 3 | Game 1 Prep | Straight, unscored | 3 min |
| 4 | Discussion before Game 1 | Discussion | 2 min |
| 5 | Game 1 | Straight, scored | 4 min |
| 6 | Discussion after Game 1 | Discussion | 2 min |
| 7 | Game 2 Prep | Free water, unscored | 3 min |
| 8 | Game 2 | Free water, scored | 5 min |

The leaderboard is not a timed section and shows no clock.

The **section clock** (confirmed requirement):

- It is shown on the classroom display and in Mission Control, and counts down from the section's planned time.
- When the planned time runs out it turns red and keeps counting into the minus (`-0:01`, `-0:02`, …). An "Over" tag and the minus sign carry the state for viewers who cannot rely on colour.
- **At zero it ends Game 1 and Game 2, and nothing else** (confirmed requirement). A scored game that is running when its clock reaches zero finishes at once with the result `time_up`: Game 1 ranks unfinished creatures by distance, Game 2 ranks by score. In every other section (joining, training, both prep rounds, both discussions) reaching zero does not end, pause, lock, or change anything: the clock goes red and the facilitator moves on when they choose.
- **It starts when the phase is loaded** (confirmed requirement), from the full planned time. Time spent staging before **Start**, and the 3-second countdown, come out of a game's time. This is deliberate: the clock exists to keep the class on schedule.
- It measures class time, so it is not frozen by pausing a round, and resetting a round within the same section does not restart it.
- The joining section has no load command, so its clock waits at the full time and starts when the first player joins or when the facilitator presses **Start Clock**, whichever comes first.
- Mission Control can change the planned time of the section on screen and can restart the clock. In a live scored game either action moves the moment the game ends, so a facilitator can give a game more time. Planned times are facilitator settings: they survive a session clear and return to the defaults when the server restarts.
- Engineering defaults for the edges of the time-up rule:
  - A scored game that is **started after its section time was already used up** is not ended the instant it starts. It runs without an automatic end, Mission Control says so when it starts, and restarting the clock or lengthening the planned time brings the automatic end back. The same applies to a round reset after time ran out.
  - A scored game that is **paused when its clock reaches zero** stays paused and ends as soon as it is resumed.
  - After a game ends on time the clock keeps counting into the minus while results are on screen.

Round endings in full: Game 1 ends when every participating creature has finished, when its clock reaches zero, or when the facilitator presses **End Round**. Game 2 ends when its clock reaches zero or on **End Round**. Game 1 Prep and Game 2 Prep have no natural end and stop only on **End Round** or when another phase is loaded. A scored round still has to be ended or paused before another phase can be loaded.

### 3.2 Keep three kinds of mode separate

Do not use one overloaded `mode` field for unrelated concepts.

| Concept | Values |
| --- | --- |
| Activity phase | `lobby`, `training`, `straight`, `freewater`, `discussion`, `leaderboard` |
| Run status | `ready`, `countdown`, `running`, `paused`, `finished` |
| Network presentation mode | `continuous`, `stroke_events` |

Additionally, record an explicit input method per player: `physical_sweep`, `tilt`, or `touch_fallback`. Input method is independent of network mode.

Discussion is its own activity phase with a topic (`before_game1` or `after_game1`), not a paused activity; ordinary pause remains available inside training and rounds. Results are the view of a finished scored round, and the leaderboard is its own phase. Each prep round is its game's phase with scoring disabled: Game 1 Prep is `straight` unscored, Game 2 Prep is `freewater` unscored. The how-to-play page is an overlay on the display rather than a phase, so it can be shown over the lobby or any staged, paused, or finished phase.

### 3.3 State-transition rules

- Loading a phase stages it in `ready`. It must not silently start a race.
- `discussion` and `leaderboard` are display-only: loading one shows it immediately, there is nothing to start, pause, or end, no input is accepted, and the facilitator leaves by loading another phase. A discussion shows its elapsed time.
- Unscored prep rounds start without a countdown and do not lock admission.
- Loading any phase hides the how-to-play page, so the display shows what was just loaded.
- Only authenticated facilitator commands may load, start, pause, resume, reset, or finish a phase.
- Require pausing or finishing an active scored round before loading a different phase.
- Training starts explicitly; it can be paused and resumed without clearing learned mappings or calibration.
- A scored start creates a server-timed countdown, then a common start instant.
- During countdown, input may update a non-propulsive preview but cannot generate progress or points.
- Pausing freezes simulation, the round's active time, positions, scores, and item timers. The section clock keeps running (Section 3.1.1). Clear all in-progress gestures; players must release and press again after resuming.
- Resuming preserves positions, scores, item state, and the round's active time.
- Returning to training preserves player identities, limb assignments, motion assignments, and valid calibration.
- Changing network mode is allowed in `ready` or `paused` and applies to everyone. Clear unfinished gestures and offer brief practice before restarting play.
- Ending or resetting a round invalidates all old input events using an updated round identifier.
- Increment a server-issued input epoch at pause/resume barriers and other global input invalidations. A delayed pre-pause stroke must not become valid simply because the same round has resumed.

## 4. Mission Control

Mission Control should share the comic ink, lettering, and palette of the pond artwork (Section 11.1) at a calmer, denser scale, and prioritize clear labels and predictable operation.

### 4.1 Primary controls

1. Current activity phase, run status, the section clock (time left or time over), and the round's active time.
2. Phase picker listing the session in running order (Explanation, Training, Game 1 Prep, Discussion before Game 1, Game 1, Discussion after Game 1, Game 2 Prep, Game 2, Leaderboard); explicit **Load phase** action.
3. Contextual **Start**, **Pause**, and **Resume** actions.
4. No "pause for discussion": discussion is loaded from the phase picker like any other step.
5. **End round** to produce results early. For the prep rounds this is the only way a round ends; a scored game also ends when its clock reaches zero.
6. Network mode selector with concise explanations of live animation versus completed-stroke updates.
7. Section clock controls: change the planned time of the section on screen and restart its clock, at any time. In a live scored game these move the moment the game ends; they never start or reset a round.
8. **Open classroom display** in another tab/window.
9. Join QR code, session URL, and admission lock.
10. **Show guide / Hide guide** toggle for the how-to-play guide on the classroom display (Section 5.1), in addition to the Explanation step in the phase picker.
11. Access to the scoped reset controls in Section 9.

Training is the main preflight phase. A facilitator should be able to tell which player needs help without watching every phone.

### 4.2 Team and player inspection

For each team, show:

- Team number, identity color/accessory, dynamic limb count (joined count), max seat cap, and connected count.
- Count of players calibrated and count with at least one accepted practice stroke.
- Individual limb IDs and stable motion assignments.
- Per-player sensor status, calibration status, connection status, current input method, last recognition result, and last accepted-stroke age.
- A selectable player/limb for reset or recalibration.

Differentiate **connected**, **sensor-ready**, **calibrated**, and **has performed a recognized stroke**. These are separate facts. Do not derive readiness from connection alone.

Network diagnostics may show measured round-trip time and delivery gaps. Do not show fabricated latency values. Diagnostics belong in Mission Control; the projected display should remain simple.

### 4.3 Admission and readiness

- Do not manually configure team count or individual team capacities on Mission Control; instead configure a universal **minimum team size** and **maximum team size** (`1 <= minTeamSize <= maxTeamSize <= 6`, default `4–6`).
- Teams spawn automatically when the first player joins a valid assigned team number (`1..15`), and each creature's limb count configures automatically to its joined player count (`1..maxTeamSize`).
- The total joined player count across the session must not exceed 30.
- Existing players rejoining do not consume a new seat or add an extra limb.
- Lock new admission before scored play so no new player joins mid-round; reconnection to an existing seat remains possible. A creature's limb count can still change during a round when a disconnected player's limb is released or a returning player's limb grows back (Section 10.1).
- Warn before starting a scored round if any joined team is below `minTeamSize`, or has disconnected or uncalibrated players. A facilitator can adjust `minTeamSize` or explicitly override the warning; record overrides in the session event log.
- Never rebalance teams, reassign limbs, or change gestures automatically to satisfy readiness.

## 5. Classroom display and training grid

### 5.1 Display composition

Design for a 16:9 classroom screen, especially 1920 × 1080, while remaining usable at laptop resolution. Do not assume participants can read small phone-sized labels from across the room.

- In both the lobby and training views, dynamically show **only** teams that have at least one joined player (`joinedCount >= 1`). Before any team joins in the lobby, center the Join QR hero panel.
- Dynamically resize and relayout team cards and creature canvases according to how many teams have joined (`1×1` for 1 team, `2×1` for 2, `3×1` for 3, `2×2` for 4, `3×2` for 5–6, `4×2` for 7–8, etc.).
- Maintain deterministic ascending `teamNumber` order as teams join and throughout training.
- A compact public header shows phase, the section clock, and pause/countdown status.
- In training, teams have already joined, so the panel to the left of the card grid is a how-to rather than the join panel. Its main content is the three beats of every stroke in large type, **1 Press** and hold the big button, **2 Move** the phone along your arrow, **3 Release** then bring the phone back, with the highlight walking through them in order. Below it is the rotation-lock reminder: where to find the control on iPhone (Control Center) and Android (Auto-rotate in quick settings). It returns every time training is loaded, and the display can hide and re-show it. If training is loaded before any team has joined, the join panel is shown instead.
- Outside the lobby, training included, the join QR is an expandable corner drawer for latecomers, kept away from active creature visuals and unavailable while admission is locked.
- A how-to-play guide covers the display at the beginning. It shows the join QR and URL, the nickname and team-number step, the motion-permission reminder (Safari on iPhone, Chrome on Android), a reminder to lock screen rotation, the six sweeps with the Press / Move / Release beats, and the shared-creature idea. It does not state the synchrony rule. It is presentation only, is showing when a session is created or cleared, can be toggled by the facilitator, cannot be turned on during a countdown or running phase, and hides automatically when a phase is loaded, starts, or resumes. The display itself has no control to show or hide it.
- No administrative reset, calibration, score-editing, or test-input buttons on the real projected view.

### 5.2 Each training card

Each card contains:

1. Large team number plus identity color/accessory.
2. The team's creature, with its controllable limbs dynamically matching the players who have joined that team.
3. A legible label on every limb showing its player's nickname, so each person can find their own paddle (label rules in Section 11.2).
4. A compact status indicator for each limb: connected / calibrated / first successful stroke.
5. A brief textual acknowledgment of the latest event, such as **Limb 3 · stroke recognized**.

During training, anchor the creature within its card. Successful strokes can cause a small forward nudge and wake before it settles back. Do not let a creature leave its card or introduce an accidental practice race.

### 5.3 Feedback hierarchy

| State | Phone response | Projected training response |
| --- | --- | --- |
| Ready | Assigned arrow, start/end markers, large hold button | Neutral limb pose and persistent readiness indicators |
| Pressed/held | Button visibly depressed; input armed | Corresponding limb indicates that it is being controlled |
| Moving | Live local movement/progress feedback | Limb follows normalized progress in continuous mode |
| Locally recognized | Immediate **Motion recognized** acknowledgment; server confirmation may still be pending | No authoritative success before acceptance |
| Server accepted | Green success cue and checkmark; optional haptic | Brief green highlight on that limb, small splash/nudge, text acknowledgment |
| Incomplete/wrong movement | Brief neutral/amber guidance after release; no propulsion | No green success; optionally show a quiet status in Mission Control |
| Returning while released | Reset cue; no input recognition | Limb returns to preparation pose without generating another stroke |
| Paused/disconnected | Clear status; disable stroke submission | Freeze/neutralize the limb; retain its identity and seat. A disconnected limb is shown as offline for the grace period, then removed (Section 10.1) |

Use a brief, localized green glow rather than repeated full-screen flashes. Approximately 200–350 ms is an initial visual timing to test, not a measured requirement. Preserve a checkmark/readiness indicator after the glow fades so success remains legible.

Do not make the whole card green when only one player succeeds. A facilitator must still be able to identify the other players who have not succeeded.

### 5.4 Discussion and leaderboard displays

A discussion fills the display with one panel: which discussion it is, a short title, and at most three questions readable from the back of the room. The prompts before Game 1 must not give away the synchrony rule; the point is for students to say it. The discussion before Game 1 has two questions: whether the team has worked out what makes the creature surge and what makes it crawl, and what it will do differently in the race. The discussion after Game 1 relates the experience to the reading (Won et al., 2015 [R1]): when the unfamiliar sweep-to-paddle mapping began to feel like one's own limb, how players changed their movement once they knew what the mapping rewarded, and how sharing one body across a team differs from one person learning a novel body. It also lists each team's Game 1 placement, time or distance, and sync share. Prompts that mention the paper must not attribute to it more than it reports.

The leaderboard shows the combined standings (Section 10.5), each team's Game 1 and Game 2 lines, and a few session highlights (fastest finish, best team sync, biggest harvest, total strokes landed). A highlight shared by several teams names all of them. Before any scored game has finished it says so instead of showing an empty table.

Neither display offers any control.

## 6. Phone controller and onboarding

### 6.1 Join behavior

The QR code opens the public participant URL and identifies the session. The player enters a name or nickname of their choosing and the team number the facilitator distributes.

- Accept any valid facilitator-assigned team number (`1..15`) while admission is open and that team has fewer than `maxTeamSize` players (within the 30-player session cap).
- Explain out-of-range, full (`>= maxTeamSize`), or locked teams clearly.
- Never silently redirect someone to another team.
- Allocate a seat atomically so two simultaneous joins cannot take the same limb.
- Require a short display name or nickname (engineering default: at most 16 characters after trimming; control and invisible characters removed). Names need not be unique; the limb number still disambiguates. On creature limb labels, teammates who chose the same nickname get their limb number appended (**Sam 1**, **Sam 2**).
- Show the nickname with the limb on the classroom display and Mission Control so teammates and the facilitator can tell who controls which limb.
- Show an unmistakable confirmation: **Sam · Team 4 · Limb 2**, matching classroom identity.
- Give a session-scoped persistent player identity and resume token, independent of the transient socket ID.
- A page refresh/reconnect should restore that identity and its assignments. A second tab must not create a duplicate active controller for the same seat. A player away for longer than the limb grace period keeps the identity but gives up the limb until they return (Section 10.1).
- **Shake to Undo on iPhone.** iOS offers "Undo Typing" when the phone is shaken, and a web page has no way to turn that off; the only guaranteed fix is the device setting (Settings → Accessibility → Touch → Shake to Undo). As mitigation, the page reloads itself once on iPhone and iPad immediately after a successful join, so the document holding the typed name and team number is discarded and nothing typed remains to be undone; the seat returns through the resume credential. The reload happens only when that credential is confirmed saved. This mitigation is **untested on a physical iPhone** and must be checked in Gate A. The phone does not show a tip about the setting (removed in revision 0.5): players are not expected to change an accessibility setting for a classroom game, so the reload is the whole mitigation.

The nickname is self-chosen, kept only in the in-memory session, preserved across reconnects and scoped resets, and discarded by **Clear entire session**. It does not have to be the participant's real name. No university account or email is necessary.

### 6.2 Onboarding sequence

1. Confirm team and limb.
2. Tap **Enable motion**.
3. Run a short capability check and show a comprehensible pass/failure result.
4. Show how to hold the phone in portrait orientation, screen facing the player at a comfortable angle, and remind the player to lock screen rotation so a sweep cannot turn the page sideways. The page cannot lock rotation itself in the supported browsers; this is an instruction to the player.
5. Capture a brief stationary reference for calibration.
6. Show an animated demonstration of that player's assigned movement.
7. Have the player perform approximately three practice attempts, with useful feedback. While training is running these attempts are also sent to the server, so they count as accepted practice strokes and animate the limb on the classroom grid; outside a running training phase they stay local to the phone.
8. Enter the controller; maintain access to the same motion demonstration. A player who has completed the three practice attempts does not have to press the button: as soon as the facilitator loads any step past training, that phone moves into the controller by itself, so nobody is left behind for forgetting. A player with fewer than three stays in practice, is told the class has moved on, and can skip ahead.

Calibration should adjust recognition to a comfortable movement, not force the person to reach a particular distance. The 50 cm boundary is a participant instruction, not a measured coordinate threshold.

### 6.3 Controller layout

Keep these elements visible without scrolling:

- Team number/color/accessory and limb ID.
- Small creature view with that person's limb highlighted.
- Assigned directional arrow and looping demonstration, with a way to stop/replay the demonstration.
- Large thumb-accessible pad carrying the three beats **Press, Move, Release**, with the beat the player is on lit: Press while idle, Move while held, Release once the stroke is accepted.
- Current recognition status and simple local feedback.
- Paused/disconnected/reconnecting status.
- Optional sound/haptics preferences where supported.

The same assigned movement remains visible throughout all phases. Essential state must be conveyed through visuals and text, including on silent iPhones.

One-screen rule (**confirmed requirement**): a player must never have to scroll while paddling. The controller is four rows sized to the visible viewport: identity and preferences; the creature view beside the assigned sweep (the sweep tile is also the stop/replay control); a status line that always reserves two lines so a longer message cannot move the pad; and the hold pad, which takes all remaining height and stays anchored to the bottom edge. The onboarding practice step follows the same rule, so the pad and the **Enter Controller** button are visible together. Both screens suppress pull-to-refresh. A phone turned sideways gets the pad on the right half and the other rows stacked on the left. Only a viewport too short for the minimum sizes (roughly below 450 px tall for the controller and 540 px for the practice step, in portrait) falls back to scrolling rather than clipping content. A layout rule written for one surface must be scoped to it; the classroom display's card sizing must not reach the phone.

Use normal touch contact, not pressure or force-touch sensing. Holding the control must not scroll the page, select text, open a long-press menu, or activate navigation gestures within the control area.

## 7. Sensor and gesture specification

### 7.1 Compatibility contract

Target Safari on modern iPhones and Chrome on modern Android phones. Do not promise support based only on model year.

Required runtime capabilities:

- HTTPS in a normal top-level browser page.
- Usable motion readings and the orientation/rotation information needed by the chosen recognizer.
- Permission granted where the browser requests it.
- Valid numeric sensor values, not merely the existence of API names.
- Foreground, visible controller page during play.

Browser motion APIs expose acceleration, orientation, and/or rotation rate, not direct hand position. Android sensor availability also varies by device [R2, R3]. Check both hardware exposure and actual browser delivery during onboarding.

Feature-detect permission-request methods individually. Request required permissions from a real user interaction. Do not assume all browsers implement the same permission method or require the same prompt.

Engineering target: local motion processing at the delivered sensor rate, typically aiming for 30–60 samples/second when available. Measure delivery on the actual phone; do not claim that a browser guarantees that rate. A configurable warning threshold around 20 motion samples/second during movement is a starting diagnostic, not a universal compatibility standard. Orientation events can be change-driven: a stationary orientation is not a sensor failure.

Use event timestamps and actual elapsed time. Do not assume a fixed sample interval or confuse milliseconds with seconds.

### 7.2 Assigned movement vocabulary

Initial physical-sweep candidates, expressed relative to a consistently held portrait phone:

| ID | Participant instruction | Desired screen-plane direction |
| --- | --- | --- |
| `left_to_right` | Sweep left to right | +x |
| `right_to_left` | Sweep right to left | −x |
| `top_to_bottom` | Sweep downward | −y |
| `bottom_to_top` | Sweep upward | +y |
| `upper_left_to_lower_right` | Sweep diagonally down and right | (+x, −y), normalized |
| `upper_right_to_lower_left` | Sweep diagonally down and left | (−x, −y), normalized |

Keep gesture direction separate from which side of the creature the limb occupies. A rightward hand gesture can operate a left-side paddle.

Normal motion should fit roughly within 10–20 cm of comfortable seated space, with approximately 50 cm as an outer instructional boundary. Do not require full arm extension. Test whether the proposed vocabulary is equally understandable and recognizable on both target platforms.

Assignment is random (**confirmed requirement**, revision 0.3). When a team is created the server draws that team's own random ordering of the vocabulary, and each limb takes the next gesture from it as players join. Teammates therefore get different sweeps (the vocabulary has six entries and a team has at most six limbs), and a gesture cannot be predicted from the team number or the order people joined in. The earlier rule derived the gesture from team number plus join order, which gave the first player of a given team the same sweep in every session.

Assignments are made once. Recalibration changes the recognition reference/thresholds, not the gesture identity or assigned limb. A refresh or reconnect restores the same seat and so the same gesture; a new draw happens only for a new seat, for example after the facilitator clears the session.

### 7.3 Press–stroke–release state machine

Recognize at most one successful stroke per button press.

| State | Behavior and exit |
| --- | --- |
| `released` | Ignore movement for gameplay. Player can return/reposition freely. A valid press arms a new attempt. |
| `armed` | Capture reference/timestamps and wait for intentional motion. Tapping without moving awards nothing. |
| `tracking` | Analyze the first significant movement and its temporal pattern. Send optional normalized visual progress. |
| `recognized_locked` | A valid stroke has been detected. Emit one uniquely identified stroke candidate; no further stroke until release. |
| `failed_locked` | Initial movement was wrong or the attempt timed out. Show guidance; require release before trying again. |

A release before recognition ends the incomplete attempt without awarding a completed stroke. A release after recognition clears the latch, allowing the next attempt. Returning while released never generates propulsion.

Always cancel the active attempt on pointer cancellation, lost pointer capture, page blur/visibility loss, phase pause/change, network loss, or calibration invalidation. Never leave a player stuck in a held state. Use pointer capture appropriately and handle release/cancel paths explicitly.

### 7.4 Physical-sweep recognizer: required approach

This is the highest-risk subsystem and must be tested first.

1. Process motion locally on the phone; network latency must not determine gesture classification.
2. Prefer valid gravity-compensated linear acceleration when exposed.
3. If only acceleration including gravity is available, use a validated gravity-removal method with orientation/reference handling. Do not classify gravity as a sweep.
4. Transform readings to a consistent gesture/reference frame, accounting for the device/browser axes. Use tested rotation conventions.
5. Determine the direction from the **first significant acceleration segment**. A wrong-way stroke must not become a correct stroke merely because its later braking acceleration points in the desired direction.
6. Look for a plausible acceleration/deceleration sequence with adequate directional consistency, signal magnitude, and duration. Allow natural human wobble.
7. Normalize any intermediate animation progress from the recognition signal. Label it as gesture progress, not measured hand position.
8. Latch success once; stop evaluating the attempt before generating feedback vibration.

Do not:

- Average signed acceleration over an entire stroke and use that average as the direction; accelerating and braking can cancel.
- Double-integrate acceleration into a supposedly accurate 2D hand path or centimeter measurement.
- Use movement speed or raw acceleration magnitude directly as race power.
- Require a magnetometer/compass heading for these relative gestures.
- Treat sensor noise, tapping the button, or haptic vibration as intentional movement.

### 7.5 Tunable starting parameters

Keep parameters centralized and documented. The following are **provisional test values**, not validated recognition thresholds:

| Parameter | Initial candidate |
| --- | --- |
| Stationary calibration | Approximately 0.5–1 second |
| Practice calibration attempts | Approximately three |
| Valid attempt duration | Approximately 0.2–1.8 seconds |
| Direction tolerance | Approximately ±35–45°, adjusted from real traces |
| Noise/onset threshold | Derived from stationary noise plus a configurable floor |
| Minimum useful signal | Derived from comfortable calibration strokes, not distance in cm |
| Maximum scoring cadence | Initially around two accepted strokes/second/player |
| End-of-stroke settling | Short configurable window, tested against normal braking and tremor |

Angle and timing checks must be sampling-rate independent. Any orientation-change rejection threshold must be tested against natural grip changes rather than chosen solely from a synthetic trace.

### 7.6 Sensor fallback policy

- Keep a separate tilt recognizer available as an explicit fallback if physical sweeps fail validation.
- Keep a touch-based directional control available for sensor-denied or unsuitable devices/access needs.
- Do not silently change physical sweeps into tilts or taps.
- Mission Control must show the active input method for each player.
- A transport-mode switch does not change the recognizer, gesture assignment, or physical input method.
- If mixed input methods are used in a scored race, make that visible to the facilitator; this remains an educational game, not a controlled scientific comparison.

## 8. Haptics, audio, and immediate feedback

Haptics are optional enhancement, not a device eligibility requirement.

- Android Chrome can use browser vibration when available and permitted.
- iPhone Safari does not expose general custom Taptic Engine control. Certain built-in switch controls have native haptics, but they are not a general API for arbitrary game events [R4, R5].
- Do not depend on hidden-switch tricks or programmatic switch clicking as the iPhone feedback implementation.
- No native app or native wrapper is required for the first classroom version.

### 8.1 Background music

Optional party-game style background music (confirmed requirement, revision 0.4; redone with recorded tracks in revision 0.5).

- One global switch in Mission Control turns it on or off for the session. It is off by default and is not reset by clearing the session.
- It plays from the classroom display only. Phones stay silent: thirty copies would not stay in time with each other.
- The music is four recorded files in `public/music/`, all published on Freesound under Creative Commons 0 and recorded in `public/music/CREDITS.txt`:

  | File | Plays | Source |
  | --- | --- | --- |
  | `lobby.mp3` | Joining, staging before a round, results after a round, and the leaderboard (looped) | "Airport Lounge" by code_box |
  | `practice.mp3` | Training and both prep rounds while they run (looped) | "Shaky Platforms" by code_box |
  | `game.mp3` | Game 1 and Game 2 from the countdown until the round ends (looped) | "Wonky Ska" by code_box |
  | `fanfare.mp3` | Once, when the leaderboard appears | "Tadaa.wav" by Exchanger |

- Discussions are silent so the room can talk.
- Use only audio whose licence allows redistribution in this repository, and record its source. Do not ship or imitate the soundtrack of an existing game.
- A track is replaced by putting a file with the same name in `public/music/`. Loudness is balanced automatically when a track loads, and encoder padding at the ends of a loop is skipped so the loop does not hiccup.
- A track that fails to load stays silent and nothing else is affected. Nothing is downloaded until music is switched on.
- **The selection is unvalidated by ear.** The tracks were chosen from their Freesound download counts, ratings, and descriptions, and measured (tempo, whole-bar length, level, a clean join at the loop point), but nobody has listened to them in a classroom. Whether they suit the room is for the owner to judge.
- Browsers block audio until the page has been clicked. A display that is waiting for that click shows a button saying so; the display's own Sound button also mutes the music locally.
- Music is presentation only and never affects game state, and nothing essential is communicated by it.

Suggested feedback:

| Event | Required feedback | Optional enhancement |
| --- | --- | --- |
| Press | Clear depressed-button/armed state | Very short Android pulse, only if it does not interfere with recognition |
| Hold/move | Local visual movement indicator | None continuously |
| Local recognition | Immediate labeled acknowledgment | Brief pulse after recognition has latched |
| Server acceptance | Green check/highlight | Short sound if enabled |
| Wrong/incomplete attempt | Clear, non-punitive text after release | Quiet optional sound |
| Team item collection | Authoritative score update and an item pop sized to the item's value | Shared display sound that grows with the item's value; avoid vibrating every player mid-stroke |

Continuous buzzing is excluded. Vibration can be sensed by motion sensors [R4]; either suppress press haptics during capture or provide a tested settling interval. Do not feed the vibration transient into the recognizer. Provide a mute control and honor reduced-motion preferences.

## 9. Reset behavior and recovery

Use explicit reset names, targets, and preservation rules. Do not implement one ambiguous global **Reset** button.

| Action | Clears or changes | Preserves |
| --- | --- | --- |
| Release stuck input: one player | Held state and current gesture attempt | Identity, team, limb, motion assignment, calibration, scores, positions |
| Recalibrate: one player | Invalidates calibration/readiness and asks that phone to calibrate again | Identity, team, limb, assigned gesture, other players |
| Reset practice: selected team | Practice counts, first-success indicators, transient feedback, practice creature pose | Team membership, limb/gesture assignments, sensor permission, valid calibration |
| Reset practice: all teams | Same practice state for all teams | Membership and mappings; valid calibration |
| Reset current scored round | Positions, velocities, scores, items, timer, finish order; creates new round ID | Players, mappings, calibration, input methods |
| Load another phase | Stages the new phase; clears active attempts; creates a new round ID | Players, mappings, calibration, training readiness |
| Clear entire session | Rosters, seat reservations, mappings, calibration, rounds, current results; creates a new session ID | Facilitator authentication |

Rules:

- Recalibration is an actual phone flow, not a host button that simply marks the player ready.
- A reset of practice is distinct from recalibration.
- Individual fixes can occur during training. Require pausing before a reset/recalibration that affects a scored round.
- A reset round returns to `ready`; it does not restart the clock immediately.
- Clear-session requires an explicit, clearly described confirmation because all players must rejoin.
- A network disconnect shorter than the limb grace period (Section 10.1) never changes team capacity, reallocates that player's limb, or grants the remaining players extra power. A longer one releases the limb.
- On pause, resume, reconnection, mode change, or reset, require a fresh press before accepting a new gesture.
- Deduplicate facilitator commands so an acknowledged retry cannot accidentally reset twice.
- The leaderboard keeps the most recently completed run of each scored game. Loading other phases or resetting a round leaves it in place; finishing that game again replaces it; a round ended before its countdown finished records nothing. Only **Clear entire session** removes it.

## 10. Creature movement and game rules

### 10.1 Shared stroke semantics

A validated, server-accepted completed stroke is the only source of propulsion. In free water it produces one fixed impulse (**implementation default**). In the straight swim its size depends on how many of the team's limbs stroked together (Section 10.3, **confirmed requirement**). Intermediate movement drives limb animation, not a second source of propulsion.

Because propulsion depends only on which strokes the server accepted and when, both network presentation modes stay equivalent:

- `continuous`: intermediate limb/progress updates plus the completed-stroke event.
- `stroke_events`: completed-stroke events and an animated stroke on receipt, without intermediate updates.

Do not award propulsion once from streamed progress and again from stroke completion. Network frame count, sample rate, phone brand, gesture force, and haptic availability must not increase propulsion. Synchrony is judged from server acceptance times, never from a phone's clock.

### 10.2 Dynamic limb layout and team-size normalization

Each creature's controllable limb count `N` equals the number of players currently seated on that team (`1..6`, starting at `0` in the lobby before anyone joins); see "Dynamic limbs" below for what happens on a disconnect:

| Joined players (`N`) | Dynamic symmetric layout |
| --- | --- |
| 1 | One center-rear paddle/tail (straight propulsion) |
| 2 | One left-side and one right-side paddle |
| 3 | One left-side and one right-side paddle, plus a center-rear paddle/tail |
| 4 | Two left-side and two right-side paddles |
| 5 | Two left-side and two right-side paddles, plus a center-rear paddle/tail |
| 6 | Three left-side and three right-side paddles |

Assign stable limb IDs and motion assignments on join (`Limb 1 .. Limb N`) and maintain them across all views and phases. Later teammates joining a creature add new limbs without altering any earlier teammate's limb ID or assigned gesture. Lock admission when a scored round starts so `N` remains fixed during the round.

Let `N` be the number of joined limbs on that creature (`team.limbCount`):

- Each accepted stroke contributes forward impulse proportional to `1/N` (scaled by the sync multiplier in the straight swim).
- For turning, normalize the total capacity of the left and right banks equally. Center-rear limbs add forward propulsion without a turning bias.
- A complete stroke cycle from every joined limb produces comparable total forward impulse regardless of whether a creature has 1, 2, 3, 4, 5, or 6 players. In the straight swim this holds for a fully synchronized cycle.
- Equal left-bank and right-bank participation cancels turning across all symmetric layouts (including odd-sized layouts with a center-rear tail).
- **Dynamic limbs** (confirmed requirement, revision 0.4, replacing "disconnection does not remove that player's limb"): a creature has exactly one limb per player currently seated on it.
  - A disconnect starts a grace period (engineering default 5 seconds). During it the limb stays, shown as offline, `N` is unchanged, and nobody's power changes, so a page refresh or a network blip never alters the creature.
  - After the grace period the limb is released: it leaves the creature, the remaining limbs are renumbered in join order, and `N` shrinks. From then on the creature behaves exactly like a team that joined at that size. This is the owner's decision; it means a team no longer carries dead weight for someone who left, and it also means a departure makes the remaining players' strokes each worth more.
  - The player's identity, team, gesture, and calibration are kept. When the same phone reconnects, the limb grows back in its old place among its teammates (limbs are ordered by join order) if the team and the session still have room. If the team filled up meanwhile, the old seat is dropped and the phone returns to the join screen.
  - A person who lost their page and joins again is a new player with a new limb. They take a gesture no seated teammate is using.
  - Team capacity and the 30-player cap count limbs on creatures, not released seats.
  - A phone finds its own limb by player identity in the live snapshot, because its limb number can change when a teammate leaves or returns.

This prevents a built-in raw-power advantage for larger teams; it does not guarantee equal human coordination difficulty.

Use a simple, damped 2D simulation with configurable forward impulse, speed limit, linear drag, angular impulse, and angular damping. Integrate using a fixed server timestep, independent of message arrival rate and display frame rate.

### 10.3 Straight swimming

- Give each team a clearly labeled lane.
- Lock heading and lateral position. Strokes advance the creature toward a shared finish distance.
- Use identical course distance and normalization rules.
- Rank finishers by authoritative server finish time.
- The first finisher never ends the race. It ends only when the last creature crosses the line, when the section clock reaches zero, or when the facilitator presses **End round**.
- At timeout, rank unfinished teams by distance; display that they did not finish.
- Freeze a finished team's simulation progress without removing its players from the session.

**Synchrony (confirmed requirement; numbers are engineering defaults).** A creature moves fast only when its limbs stroke at the same time.

- Accepted strokes from different limbs of one team that arrive within the sync window of the group's first stroke form a **sync group**. A stroke outside the window, or a second stroke from a limb already in the group, starts a new group.
- A group of `k` limbs out of `N` joined limbs is worth `k × (base / N) × m(k)` forward impulse, where the multiplier `m` rises linearly from the minimum for a lone stroke to the maximum when `k = N`. Unsynchronized strokes therefore still move the creature, at a penalty.
- The group is re-priced each time a limb joins and only the difference is granted, so the total does not depend on which stroke arrived first.
- `N` is the number of limbs on the creature (Section 10.1). A disconnected player still counts through the grace period, which lowers the sync the team can reach and never raises anyone's power; once their limb is released, `N` shrinks and full sync is reachable again. A one-limb creature is always fully in sync.
- A fully synchronized cycle is worth the same for every team size.
- The window stays below the per-player minimum stroke interval so one limb cannot join a group twice, and fast unsynchronized paddling cannot beat slower synchronized paddling.

Larger teams have more people to coordinate; the normalization equalizes power, not human difficulty. State the rule plainly on the leaderboard and in facilitation rather than presenting it as a hidden bonus.

**Game 1 Prep** is the same lanes with scoring disabled: no countdown, no ranking, and a creature that reaches the end of the course starts another lap. Students use it to discover the rule, so the display does not label synchrony during prep. In the scored race the display may call out how many limbs just landed together.

### 10.4 Free-water practice and collection

- Use a shared arena with all teams visible.
- Use the same limbs, assignments, recognizer, and stroke power as the straight race.
- Unlock turning: left-side strokes tend to turn toward the right; right-side strokes tend to turn toward the left. Choose and document a consistent coordinate/yaw convention.
- Use damping and bounded turning so a single accidental stroke does not create uncontrollable spinning.
- Allow overlap between creatures; disable inter-team collisions.
- Keep creatures within the arena using readable boundary behavior, such as soft wall response, rather than wrapping to the opposite side.
- Offer an unscored steering familiarization (Game 2 Prep; planned at 3 minutes, ended by the facilitator, never by the clock). **Game 2 Prep has items to collect too** (confirmed requirement, revision 0.4): they behave exactly as in Game 2 and their points show on the display under a **Practice** heading, but no result is recorded and nothing reaches the leaderboard. Reset positions, items, and scores before the scored collection countdown.
- **Item kinds and points** (confirmed requirement, revision 0.4; the specific values are engineering defaults): items differ in value and in how loudly the display celebrates them.

  | Kind | Points | How often | Collection effect on the display |
  | --- | --- | --- | --- |
  | Glow seed | 100 | Common | Small starburst and `+100`, short tone |
  | Golden bug | 300 | Uncommon, at most 4 in the water | Larger spinning burst, more smoke, **NICE!** and `+300`, two-note tone |
  | Pond star | 1,000 | Rare, at most 1 in the water | Arena-wide flash, shockwave rings, double burst, **TEAM N JACKPOT!** and `+1000`, fanfare |

  The kind of each new item is drawn from the round's seeded generator. All kinds share one collision radius, so the rare ones are not easier to hit. Reduced-motion settings drop the flash, rings, spin, and smoke.
- **Live scoreboard** (confirmed requirement, revision 0.4): during Game 2 and its prep the display carries a column of large score tiles beside the water, ordered by score, with the leader highlighted, each score bumping when it changes and the points just gained popping beside it. Point values are deliberately large round numbers.

Collection rules:

1. Contact is evaluated against the creature body's 2D collision footprint, not the apparent ends of decorative limb sprites.
2. On contact, the server removes the item exactly once and increments one team's score.
3. Broadcast the authoritative collection event with the item's kind and points; animate the collection effect and score update.
4. If two creatures contact the same item in the same simulation tick, use nearest-center distance, then a stable team-ID tie-break for exact equality.
5. Initial items and team starting positions should offer comparable opportunities. Do not spawn an item already inside a creature.
6. Default: maintain approximately 10–12 items, replacing a collected item after a short configurable delay, initially one second. Replacement is an implementation default; disappearance on collection is confirmed.
7. Winner is the highest score when active time expires. Equal scores can share a rank; do not introduce a hidden tie-break.

Use a seeded layout generator for repeatable tests. Exact seed selection is a facilitator/configuration detail.

### 10.5 Leaderboard

The leaderboard phase (**confirmed requirement**) reports the session's competition statistics from results the server froze when each scored round finished.

- Per team, Game 1: rank, finish time or share of the course covered, accepted strokes, mean sync share (the average, over the team's strokes, of the fraction of joined limbs in that stroke's sync group), and the number of fully synchronized strokes.
- Per team, Game 2: rank, points, items collected, accepted strokes.
- Combined standings (**implementation default**): in each completed game a team ranked `r` out of `T` teams earns `T − r + 1` points; points are summed across games. Teams sharing a rank earn the same points, and teams with equal totals share an overall rank. Do not add a hidden tie-break.
- Prep rounds and training never appear on the leaderboard.

## 11. Art direction and asset contract

### 11.1 Visual target

Create an original, animated pond world drawn like an American comic / pop-art page. The reference is the broad visual character of a printed action comic: thick black ink outlines, halftone dot fills, radial speed lines, starburst and speech-bubble callouts, chunky outlined lettering with short onomatopoeia ("SPLASH!", "POW!"), and saturated cyan-blue, hot pink, yellow, orange, and red. The interface should read as an engaging game, not as a dashboard.

The proposed creature is a round lily-bulb/pond creature with oversized leaf paddles. This character design is an implementation/art default; the many-limbed team body and the comic direction are confirmed. The comic direction replaces the earlier painted 2.5D direction.

- Overhead camera. Flat cel shading with one hard shadow tone and halftone dots instead of painted gradients.
- Bright comic-blue water with halftone texture and sparse wave marks; decoration stays at arena edges.
- Inked bodies with hard offset shadows, squash-and-stretch on accepted strokes, and readable speed lines.
- Distinct team body colors plus numbers/accessories so identity does not rely on color alone.
- Three collectibles that read as common, better, and rare at a glance: a glow seed, a larger golden bug, and a much larger pond star with a turning halo. Items worth more than a seed show their point value beneath them. The collection effect grows with the item (Section 10.4).
- Panels with ink borders and hard drop shadows, caption boxes, speech bubbles, arcade-style buttons, and high-contrast readable text (body text at least 4.5:1).
- One comic system, three intensities: the classroom display is the loudest, the phone controller is bold but dominated by the hold pad and status, and Mission Control keeps the same ink and lettering at a denser, calmer scale.

Motion is part of the direction: panels and callouts pop in, the countdown slams, and an accepted stroke gets a localized reaction on its own limb (Sections 5.3 and 8). Comic effects never replace state. The success cue stays green and limb-local, callouts must not cover labels or controls, and reduced-motion preferences (Section 11.3) remove the animation while keeping every static indicator.

Keep the simulation plane and collection footprints clear. Decoration must not hide a limb or make object contact look spatially incorrect.

### 11.2 Modular creature assets

Require independently renderable layers/components:

1. Body and face.
2. Each paddle/limb, with a defined attachment point and pivot.
3. Optional center-rear paddle/tail for five-player teams.
4. Team accessory/color treatment.
5. Water shadow.
6. Wake/splash particles.
7. Recognition highlight.
8. Limb label layer, readable regardless of body rotation. Each label shows the player's nickname (limb number for a limb nobody holds). Long names are shortened with an ellipsis to a width that scales with the creature, labels sit outside the paddle tips, neighbouring labels are pushed apart instead of overlapping, and in the straight race each team's labels stay inside its own lane.

One baked image of a creature is insufficient if its limbs cannot animate independently.

Support preparation, held/moving, stroke, recovery, and paused poses. In continuous mode the animation must accept normalized gesture progress. In event mode it must play a completed-stroke animation without granting extra power.

### 11.3 Readability and accessibility

- Keep all 4–6 limbs visible in training.
- On each phone, prominently identify its own limb.
- On the classroom screen, show team numbers and a stable limb-label convention.
- Honor reduced-motion preferences; preserve static success indicators when animations are reduced.
- Support large touch targets and readable controller text.
- Keep the entire stroke control and recognition result visible in portrait without scrolling.
- Avoid constant flashing, excessively busy water textures, or high-volume overlapping sounds.

Temporary procedural shapes are acceptable during engineering, but must be labeled as placeholder art in the agent's handoff. Do not call the intended art direction finished until representative assets have been reviewed.

## 12. Technical architecture and protocol

### 12.1 Recommended baseline

Implementation defaults:

- One Node.js service, using a supported LTS release and pinned dependencies.
- TypeScript for shared event/data contracts and server logic.
- Socket.IO for bidirectional events, rooms, acknowledgments, and reconnection.
- A lightweight web client; React with Vite is a reasonable default if starting from an empty project.
- Canvas 2D or modular 2D sprites for creatures/arena; normal DOM controls for Mission Control and phone UI.
- In-memory authoritative state for a single classroom session; no database required for the initial version.
- One origin for controller, display, assets, and live connections.

Do not introduce multiple server instances, distributed state, full 3D physics, or a native mobile app for the first release.

### 12.2 Server authority

The server owns:

- Team membership, capacities, limb IDs, motion assignments, and calibrated/readiness status.
- Current phase, run status, network mode, identifiers/versions, countdown, and active-time clocks.
- Accepted stroke IDs and rate limits.
- Creature positions, velocities, headings, scores, finish order, items, and collection decisions.
- Facilitator commands and permissions.

Phone sensor classification happens on the client. Server authority over game state does not prove that a player physically performed the gesture. The server must still validate identity, assignment, event lifetime, phase, deduplication, and cadence.

No participant or public display can submit arbitrary position, score, winner, phase, calibration approval, or administrator changes.

### 12.3 Core records

| Record | Required fields/concepts |
| --- | --- |
| Session | Session ID/epoch, state revision, phase, run status, global input epoch, network mode/version, admission status, team configuration, current round ID |
| Team | Stable team ID/number, capacity, limb layout, player seats, public identity, training counters/readiness |
| Player | Stable player ID, resume credential, team/limb IDs, assignment ID, input method, connection generation, sensor status, calibration version, current attempt, last accepted-stroke time |
| Motion assignment | Gesture ID, desired direction, reference-frame convention, immutable assignment version |
| Calibration | Version, reference/bias/noise estimates, derived thresholds, validated status; never raw position in centimeters |
| Round | Round ID, phase, scoring enabled, run status, seed, active duration, team simulation records, finish records, items |
| Stroke | Unique stroke ID, attempt/press sequence, session ID, round ID, input/connection epoch, calibration version, gesture ID, duration and completion timing |
| Item | Unique ID, position, collision radius, availability, collection owner/time when relevant |
| Facilitator command | Unique command ID, target, expected session/round revision, command type, acknowledgment/result |

Do not include resume credentials, host credentials, or private diagnostics in public snapshots.

### 12.4 Event contracts

Names below are suggested; preserve the semantics even if names change.

| Direction | Event | Semantics |
| --- | --- | --- |
| Phone → server | `player.join` | Requested configured team number; atomically allocate or explain failure |
| Phone → server | `player.resume` | Resume credential; restore the same seat and assignments |
| Phone → server | `sensor.status` | Capability/calibration progress; not proof that a stroke occurred |
| Phone → server | `calibration.complete` | Current assignment/calibration version and derived parameters; validate shape and version |
| Phone → server | `input.begin` / `input.release` | Versioned press/release transitions and unique attempt sequence; low-rate control events in both network modes |
| Phone → server | `input.preview` | Held/moving state and normalized limb progress; latest-only, disposable |
| Phone → server | `input.cancel` | Clear an unfinished attempt |
| Phone → server | `stroke.complete` | Unique candidate stroke; requires explicit accepted/rejected acknowledgment |
| Host → server | `host.command` | Authenticated phase, start, pause, resume, mode, admission, or scoped reset command |
| Server → clients | `session.snapshot` | Full current authoritative state, sanitized per role |
| Server → clients | `phase.changed` / `round.status` | Current phase/status with server time and identifier/version |
| Server → relevant clients | `stroke.accepted` | Exactly one authoritative stroke effect plus identifiers |
| Server → relevant clients | `item.collected` | Item ID, item kind, points awarded, collecting team, new score, round ID |
| Server → phone | `player.recalibrate` | Invalidate that player's calibration and open its real recalibration flow |
| Either direction | `connection.probe` | Measured timing diagnostics and clock-offset estimation |

Every acknowledgment should contain a machine-readable result code and a useful display message. Include current identifiers/revision when rejecting stale commands.

### 12.5 Reliable events versus disposable updates

Socket.IO ordering and reconnection features do not remove application-level delivery/deduplication requirements. Standard disconnected emits can be buffered, while retries can produce duplicate application events [R6].

Requirements:

- Process sensor samples locally. Do not stream raw accelerometer samples to all browsers.
- Initial continuous preview rate: up to 15–20 updates/second/player. At 30 players and 20 Hz this is approximately 600 preview messages/second.
- Use connected-state gating and disposable/volatile delivery for preview frames; coalesce to the newest state. Do not rely on a volatile flag alone to enforce all no-buffer guarantees.
- Send press/release/cancel transitions in both modes. Event mode can omit intermediate progress while still clearing held states correctly. A stroke candidate must reference a current, non-expired attempt; opening that attempt need not block local recognition.
- Accepted gameplay strokes need unique IDs, bounded acknowledgment retries, and server deduplication.
- Explicitly avoid queuing gameplay strokes while offline.
- On reconnect, change the connection/input generation, discard old attempts and local outgoing gameplay buffers, fetch a current snapshot, and require a fresh press.
- Acknowledge repeated delivery of an already accepted stroke without applying its impulse again.
- Reject strokes from old rounds, old sessions, old calibration versions, old connection generations, old global input epochs, or paused/finished phases.
- Expire delayed strokes rather than allowing a backlog to burst into propulsion after a stalled connection. A starting freshness window around two seconds is configurable and must be tested.
- Use server-issued generations and measured clock offset/receipt windows for freshness. Do not trust an arbitrary phone wall clock for race ordering.
- Public state snapshots around 10–20 Hz and client interpolation are initial presentation defaults. Latest-only snapshots must supersede older revisions.
- Deduplicate visual effects by event/round ID. Reconnection should restore current readiness and scores without replaying a backlog of old splashes, green flashes, or item awards.
- Check that event mode does not leave unnecessary high-rate preview traffic running.

Connection-state recovery may be enabled as an optimization, but a fresh authoritative snapshot and stable player identity must work without it [R7].

### 12.6 Clocks, pause, and stale input

- Use a server monotonic clock for elapsed simulation time.
- Calculate finish times from active time only; pausing must not add to a round's active time. The section clock is separate wall-clock time: it decides when a scored game ends but is never used to compute a finish time or a score.
- Use server start/finish times for rankings.
- Clear an active input on missing/canceled control updates using a watchdog; an abandoned hold must not remain visible indefinitely.
- Do not continue a gesture across a pause, phase change, calibration change, reconnect, or network-mode change.
- End a scored round once. Duplicate finish/end commands must not produce different winners.

### 12.7 Trust boundaries

- Protect Mission Control with a server-validated facilitator credential configured outside source code.
- Verify authorization on each control event; hiding a button is not authorization.
- Keep public display connections read-only.
- Validate event shapes, lengths, numeric bounds, and per-player rate limits.
- Do not accept arbitrary participant-supplied team membership, limb assignment, score, or position.
- Avoid logging or projecting credentials.
- Developer-only simulated controls must be clearly marked and disabled by default in classroom deployment.

## 13. Deployment and operation

Run the game on the user's Linux machine through SSH. The machine does not need a GPU for this design; browsers render the graphics.

The deployment handoff must provide:

- Exact tested Node/runtime and dependency versions.
- Build, start, and meaningful test commands.
- An environment-variable template without secrets.
- A process manager or service configuration so disconnecting SSH does not stop the game.
- A health endpoint and concise logs for joins, reconnects, phase changes, errors, and resets.
- How to obtain/open `/control`, `/screen`, and `/play`.
- How to verify the final public HTTPS URL and live connection path from a phone.
- How to restart intentionally and what state is lost.

The actual SSH host, user, hostname/domain, and existing tunnel/proxy configuration have not been supplied. Do not invent them.

Use a reachable HTTPS endpoint and a proxy/tunnel supporting the chosen live transport. A Cloudflare Tunnel is a candidate if the operator's setup supports it: it maps public hostnames to local HTTP services and supports WebSockets [R8]. SSH reachability alone does not establish phone/browser reachability.

Initial process restart behavior may create a fresh classroom session. If durable crash recovery is added, document and test it separately; do not claim that network reconnection support also guarantees recovery after losing server memory.

## 14. Acceptance tests and classroom readiness

Implement meaningful automated tests for state/recognition invariants and use real-device tests for browser/sensor behavior. A synthetic load test is not evidence that physical gestures work.

### 14.1 Phone recognition tests

| Scenario | Required result |
| --- | --- |
| Stationary phone with button pressed | No stroke |
| Tap without a sweep | No stroke |
| Correct assigned sweep | At most one candidate/accepted stroke per press |
| Opposite-direction sweep | No acceptance from its later braking segment |
| Diagonal assigned sweep | Recognized with realistic tolerance; incorrect perpendicular movement rejected |
| Return while released | No stroke and no propulsion |
| Multiple sweeps while still held | At most one success until release |
| Release/cancel during attempt | Clean reset; next press works |
| Gravity or orientation change without intended sweep | No false stroke |
| Button/haptic transient | No false stroke |
| Different sample rates and timing gaps | Stable time-based behavior; no frame-count advantage |
| Recalibration | Same gesture/limb, updated calibration version, old attempt rejected |

Physical-device checks are mandatory on at least one actual iPhone/Safari and one actual Android/Chrome:

- Permission acceptance/denial and recovery.
- Actual event fields, axes, orientation handling, delivery intervals, and gravity-removal behavior.
- Small seated left/right sweeps and both diagonal directions.
- Repeated use of the hold control without browser scrolling or long-press interference.
- Page background/foreground and network reconnect.
- Comfortable recognition with imperfect grips/movements.
- Haptics where available, with visual feedback working independently.

Proposed prototype gate, to be reviewed after testing: at least 9 of 10 deliberate attempts recognized for each tested motion on each platform, zero duplicate scores per press, and no more than 1 false acceptance in 20 negative trials. These small trials are engineering checks, not research findings or a universal accuracy guarantee.

### 14.2 Server and game tests

| Scenario | Required result |
| --- | --- |
| 30 players plus host/display clients | Player cap works; non-player connections do not consume seats |
| 31st distinct player | Clear capacity rejection |
| Two simultaneous joins to one remaining seat | Exactly one succeeds |
| Mistyped/full team number | No silent reassignment or new team creation |
| Refresh and reconnect | Same team, gesture, and seat; same limb when it happens inside the grace period |
| Second controller for the same identity | No duplicate active input owner |
| Duplicate stroke/retry | One impulse and one counter increment |
| Old round/session/input/calibration event | Rejected without state change |
| Pre-pause stroke delivered after resume | Rejected using the changed input epoch, even though round ID is unchanged |
| Pause/countdown/finished input | No propulsion or score change |
| Pause for 20 seconds | The round's active time is unchanged; the section clock has advanced 20 seconds |
| Four-/five-/six-limb complete cycles | Comparable total forward impulse; no unexplained bank-turning bias |
| Straight swim, 1 to N limbs stroking together | Speed rises with every additional limb in sync; the same strokes spread outside the window earn only the out-of-sync rate |
| Fully synchronized cycle at each team size, in both network modes | Same total impulse; independent of arrival order inside the window |
| First creature finishes the straight race | Round keeps running; it ends when the last creature finishes or at time up |
| Game 1 or Game 2 reaches zero on its section clock | Round finishes with `time_up`; staging time and the countdown counted against it |
| Training, a discussion, or a prep round runs past its planned time | Clock is negative; phase, run status, round ID, input epoch, scores, and results are all unchanged; strokes still count |
| Scored game started, or reset, after its time was used up | Does not end at once; restarting the clock arms the automatic end again |
| Scored game paused across zero | Stays paused; ends on resume |
| Phase loaded | Section clock restarts from that section's planned time; the leaderboard has no clock |
| Lobby before anyone joins | Joining clock waits at its full time; first join or **Start Clock** starts it |
| Planned time edited or clock restarted during a live scored game | The end of the game moves with the clock; round ID, epoch, positions, and scores are untouched |
| Game 1 Prep | No countdown, no admission lock, laps instead of a finish, nothing recorded for the leaderboard |
| Discussion phase | Carries its topic; start, pause, end, and strokes are all rejected |
| Leaderboard | Keeps each completed game, placement points add up, tied totals share a rank, cleared only with the session |
| One disconnected player | Inside the grace period: no power increase for remaining players, reachable sync drops. After it: the limb is released, the others are renumbered, and strokes are priced for the limbs left on the creature |
| Released limb returns | Same identity, team, and gesture; limb grows back in its old place if the team has room, otherwise the phone is sent back to the join screen |
| Person rejoins as a new player after losing their page | Joins as a new limb; no ghost limb remains and team capacity counts only limbs on the creature |
| Switch continuous/event modes | Same accepted-stroke power and scoring |
| Two teams contact one item simultaneously | One item removal and one award |
| Race ended by time up or by the facilitator with creatures still out | Finishers ranked by time; unfinished teams clearly ranked by distance |
| Scoped resets | Exactly the documented fields clear; membership/mappings survive where specified |
| Unauthorized host command | Rejected by server |

### 14.3 Display and facilitator tests

- Six-team training grid is readable at 1920 × 1080 and usable on a laptop.
- The correct limb responds to each phone; IDs agree on all surfaces.
- Success is distinguishable from merely holding/moving.
- A team with one successful player and four unsuccessful players does not appear fully ready.
- A short green highlight leaves a persistent success indicator.
- Training creatures remain within their own cards.
- The classroom display cannot perform administrative actions.
- Loading a phase stages it; starting is a separate operation.
- Single-player recalibration opens a real phone flow and does not change assignments.
- Reduced-motion and muted operation preserve essential feedback.
- A finished first game can transition into unscored steering practice and then a fresh scored collection round.

### 14.4 Network/load rehearsal

Simulate 30 players sending up to 20 preview updates/second and realistic completed strokes, with a host and classroom display connected.

Test representative added round-trip delays such as 100, 250, and 500 ms, plus jitter, application-message gaps, and reconnects. Record actual results rather than claiming universal latency tolerance.

Verify:

- Input does not accumulate in an unbounded queue.
- Local recognition feedback stays responsive even when network confirmation is delayed.
- No burst of old strokes appears after recovery.
- Server simulation remains stable and pause/reset commands remain usable.
- The low-traffic mode actually reduces message volume.
- Visual interpolation does not award or predict authoritative points.

Finish with a rehearsal on the actual classroom Wi-Fi or intended access path. The decisive deployment test is phone motion working end to end through that URL.

## 15. Implementation order and required agent handoff

### Gate A — sensor laboratory first

Build the smallest phone page that can:

1. Enable/check sensors.
2. Assign a single movement.
3. Calibrate.
4. Capture a hold–sweep–release attempt.
5. Show raw/processed diagnostic traces locally in development.
6. Report recognition and reason for rejection.

Test on the two actual platforms before asserting that physical-sweep recognition is dependable. If a required phone is unavailable, continue independent server/UI work but clearly report this validation as outstanding.

### Gate B — one player, one live limb

Connect one phone to a projected training card. Verify fixed assignment, local feedback, server acceptance, live animation, completed-event mode, release handling, pause, and reconnect.

### Gate C — team training and Mission Control

Implement configurable 4–6-player teams, QR join, stable seats, team-card grid, readiness inspection, phase state machine, and all scoped resets.

### Gate D — core straight race

Implement normalized propulsion, staged starts, countdown, timer, lanes, finish order, results, and network/load tests.

### Gate E — optional collection

Implement steering familiarization, free-water simulation, authoritative contact collection, item replacement, score/results, and fair starting layout.

### Gate F — art, feedback, and deployment rehearsal

Integrate modular artwork, readable UI, localized success effects, optional sound/haptics, production configuration, and physical classroom rehearsal.

The straight race is the core deliverable. If time is limited, deliver a reliable join → train → Game 1 Prep → discussion → straight race → results experience before polishing the optional collection mode.

Required implementation-agent handoff:

- Source project and pinned dependencies.
- Setup/run/build/test instructions.
- Tested deployment procedure and required configuration.
- Asset inventory and placeholder/final-art status.
- Meaningful automated test results.
- Actual device/browser test matrix.
- Known limitations, especially untested sensor behavior and iPhone web haptics.
- A brief facilitator runbook covering joining, training, pause/discussion, games, reconnect, and scoped reset actions.
- Explicit distinction between working features, development simulations, and unvalidated assumptions.

## 16. Inputs still needed and change policy

These do not block writing the first sensor prototype:

1. Actual Linux SSH destination and HTTPS/tunnel/proxy setup.
2. Availability of an iPhone and Android phone for physical testing.
3. Actual attendance/team capacities and how group numbers will be distributed.
4. Final reviewed character/art assets and any preferred game title.
5. Exact activity time budget, and the owner's confirmation of the draft discussion-question sentences.

The following must remain stable unless the user explicitly changes the design:

- One player, one limb, one assigned movement throughout the activity.
- Assigned team-number joining.
- Seated, compact movement.
- Press and hold for the working stroke, move along the assigned arrow, release for the return. Every surface names these three beats the same way: **Press, Move, Release**.
- Team-card training grid and recognizable success feedback.
- Straight race first, optional free-water collection later.
- Item disappearance on collection.
- Facilitator control over phase and scoped resets.

If physical sweeps fail the validation gate, report the observed failure and propose a tilt fallback clearly. Do not quietly replace the intended interaction and call the original specification complete.

## 17. Primary references and factual boundaries

The gameplay rules, UI layouts, thresholds, time limits, and implementation choices above are design requirements/defaults. The references below support platform constraints and research context; they do not validate this game's recognizer or classroom effectiveness.

- **[R1] Research context:** Won et al. (2015), [Homuncular Flexibility in Virtual Reality](https://doi.org/10.1111/jcc4.12107). The supplied course PDF was consulted for the conceptual distinction between remapped/additional avatar limbs and this game's collective control.
- **[R2] Browser motion:** W3C, [Device Orientation and Motion](https://www.w3.org/TR/orientation-event/). Sensor event contents, coordinate conventions, permission/secure-context requirements, and visibility behavior.
- **[R3] Android hardware context:** Android Developers, [Motion sensors](https://developer.android.com/develop/sensors-and-location/sensors/sensors_motion). Native sensor descriptions establish hardware concepts; they do not guarantee exposure in a particular web browser.
- **[R4] Browser vibration:** W3C, [Vibration API](https://www.w3.org/TR/2026/CRD-vibration-20260520/). Chromium implementation status, basic vibration behavior, and interaction with motion-sensor signals.
- **[R5] iPhone web haptics:** WebKit, [WebKit Features in Safari 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/) and [Vibration API feature request, bug 288846](https://bugs.webkit.org/show_bug.cgi?id=288846). Built-in switch feedback is distinct from general programmable haptics.
- **[R6] Socket.IO event semantics:** official [client socket source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-client/lib/socket.ts), inspected through current documentation retrieval. Review buffering, acknowledgments, retries, and volatile-event behavior for the pinned version.
- **[R7] Socket.IO recovery:** official [server socket source](https://github.com/socketio/socket.io/blob/main/packages/socket.io/lib/socket.ts) and [in-memory adapter source](https://github.com/socketio/socket.io/blob/main/packages/socket.io-adapter/lib/in-memory-adapter.ts). Recovery is optional optimization, not the sole identity/state mechanism.
- **[R8] Candidate tunnel:** Cloudflare, [Published-application routing](https://developers.cloudflare.com/tunnel/concepts/routing/) and [Tunnel FAQ: WebSockets](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/).

Platform documentation checked on 15 November 2026. The implementation agent must verify exact APIs against the dependency and browser versions it actually uses.

