# CS260B Shared-Body Pond Game — Implementation Specification

Version: 0.1 · Prepared: 15 November 2026

Status: implementation handoff; the game has not been implemented or validated on physical phones.

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
| Participants | At most 30 players, divided into teams of 4–6. Facilitator and display connections do not consume player seats. |
| Team body | One creature per team, with one independently controlled limb per participant. |
| Joining | One QR code; players enter a facilitator-assigned team number. Never silently place a player into another team. |
| Assignment | Each participant keeps the same limb and assigned motion from onboarding to the end. |
| Input | Easy directional movements, including left-to-right, right-to-left, and diagonal sweeps. |
| Seated use | Keep movements compact and below approximately 50 cm. Small comfortable movements are the normal case. |
| Stroke cycle | Press and hold during the working movement; release while returning to the starting position. |
| Training | A checkerboard/grid of team cards on the classroom display. Each card contains its team's creature and live limb feedback. |
| Recognition feedback | A successful movement causes visible feedback, such as a green highlight, and a small forward-swimming response. |
| First game | Straight swimming race: reach the finish line first. |
| Optional second game | Free-water steering and item collection, if time permits. |
| Collection | An item disappears on contact and awards the collecting team a point. |
| Facilitator | Private Mission Control to operate phases, pause/resume, and reset specific state. |
| Network modes | Live limb updates and a lower-traffic completed-stroke mode; facilitator chooses a common mode between active rounds. |
| Visual direction | Playful cartoon pond, inspired by the chunky, expressive visual language of Plants vs. Zombies, with a 2.5D appearance. |
| Devices | Modern iPhones and Android phones, subject to an actual browser sensor capability check. |
| Hosting | One Linux server managed over SSH; participants and classroom computer use normal web browsers. |
| Haptics | Provide additional haptic feedback where the browser permits it; essential feedback must work without vibration. |

### 1.3 Initial implementation defaults

- Six teams of five, editable in the lobby; support other 4–6-player configurations within the 30-player cap.
- Mostly overhead world view with mild illustrative depth; game geometry remains two-dimensional.
- Training is untimed by default, with a visible elapsed timer and facilitator-controlled ending.
- Three-second shared countdown before either scored game.
- Straight race: 90-second limit; tune course length so a practiced team can finish in approximately 45–75 seconds.
- Free-water game: 90 seconds, editable to 60 seconds.
- Brief discussion after training and before the first race.
- All team creatures can overlap in free water; there are no creature-to-creature collisions.
- Equal value for all collectible items.
- Primary gesture candidate: short physical sweeps, recognized locally from motion signals. Directional tilts are an explicit development fallback, not an automatic replacement.
- Both network modes award exactly the same fixed propulsion for the same accepted stroke. The difference is how often intermediate limb animation updates are sent.

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

1. Facilitator configures team numbers and capacities in the lobby.
2. Classroom display presents the join QR code and a readable short URL.
3. Players enter their assigned team number, receive a limb, enable motion access, and complete calibration.
4. Facilitator opens training. The display changes to the team-card grid.
5. Players practice their own movements; recognized strokes animate the corresponding limbs and generate green success feedback.
6. Facilitator pauses training for discussion.
7. Facilitator loads the straight race, starts the countdown, and runs the race.
8. Display shows race results.
9. If time permits, facilitator loads free water, enables a short unscored steering practice, then starts scored collection.
10. Display shows collection results; facilitator can return to training or end the activity.

Indicative allocation: joining 2 minutes; training 2 minutes; discussion 1–2 minutes; straight race 1–1.5 minutes; optional steering familiarization 15–20 seconds and collection 1–1.5 minutes. Timing remains under facilitator control.

### 3.2 Keep three kinds of mode separate

Do not use one overloaded `mode` field for unrelated concepts.

| Concept | Values |
| --- | --- |
| Activity phase | `lobby`, `training`, `straight`, `freewater` |
| Run status | `ready`, `countdown`, `running`, `paused`, `finished` |
| Network presentation mode | `continuous`, `stroke_events` |

Additionally, record an explicit input method per player: `physical_sweep`, `tilt`, or `touch_fallback`. Input method is independent of network mode.

Discussion uses a paused activity, not an additional simulation phase. Results are the view of a finished scored round. Free-water practice is the free-water phase with scoring disabled.

### 3.3 State-transition rules

- Loading a phase stages it in `ready`. It must not silently start a race.
- Only authenticated facilitator commands may load, start, pause, resume, reset, or finish a phase.
- Require pausing or finishing an active scored round before loading a different phase.
- Training starts explicitly; it can be paused and resumed without clearing learned mappings or calibration.
- A scored start creates a server-timed countdown, then a common start instant.
- During countdown, input may update a non-propulsive preview but cannot generate progress or points.
- Pausing freezes simulation, active-time clocks, positions, scores, and item timers. Clear all in-progress gestures; players must release and press again after resuming.
- Resuming preserves positions, scores, item state, and remaining active time.
- Returning to training preserves player identities, limb assignments, motion assignments, and valid calibration.
- Changing network mode is allowed in `ready` or `paused` and applies to everyone. Clear unfinished gestures and offer brief practice before restarting play.
- Ending or resetting a round invalidates all old input events using an updated round identifier.
- Increment a server-issued input epoch at pause/resume barriers and other global input invalidations. A delayed pre-pause stroke must not become valid simply because the same round has resumed.

## 4. Mission Control

Mission Control should feel related to the pond artwork, but prioritize clear labels and predictable operation.

### 4.1 Primary controls

1. Current activity phase, run status, and active/remaining time.
2. Phase picker: Training / Straight swim / Free water; explicit **Load phase** action.
3. Contextual **Start**, **Pause**, and **Resume** actions.
4. **Pause for discussion**, preserving the current simulation state.
5. **End round** to produce results without waiting for the timer.
6. Network mode selector with concise explanations of live animation versus completed-stroke updates.
7. Round duration controls while staged or paused; do not retroactively change an active round without an explicit host action.
8. **Open classroom display** in another tab/window.
9. Join QR code, session URL, and admission lock.
10. Access to the scoped reset controls in Section 9.

Training is the main preflight phase. A facilitator should be able to tell which player needs help without watching every phone.

### 4.2 Team and player inspection

For each team, show:

- Team number, identity color/accessory, target capacity, joined count, and connected count.
- Count of players calibrated and count with at least one accepted practice stroke.
- Individual limb IDs and stable motion assignments.
- Per-player sensor status, calibration status, connection status, current input method, last recognition result, and last accepted-stroke age.
- A selectable player/limb for reset or recalibration.

Differentiate **connected**, **sensor-ready**, **calibrated**, and **has performed a recognized stroke**. These are separate facts. Do not derive readiness from connection alone.

Network diagnostics may show measured round-trip time and delivery gaps. Do not show fabricated latency values. Diagnostics belong in Mission Control; the projected display should remain simple.

### 4.3 Admission and readiness

- Configure capacities of 4, 5, or 6 before players join.
- The total configured seat count must not exceed 30.
- With a minimum of four seats per team, support up to seven teams.
- Existing players rejoining do not consume a new seat.
- Lock new admission before scored play; reconnection to an existing seat remains possible.
- Warn before starting with missing, disconnected, or uncalibrated players. A facilitator can explicitly override the warning; record that override in the session event log.
- Never rebalance teams, reassign limbs, or change gestures automatically to satisfy readiness.

## 5. Classroom display and training grid

### 5.1 Display composition

Design for a 16:9 classroom screen, especially 1920 × 1080, while remaining usable at laptop resolution. Do not assume participants can read small phone-sized labels from across the room.

- Main content: one bounded card/pool per team, arranged in a regular grid.
- Default for six teams: three columns by two rows.
- Reflow for other team counts; up to seven teams can use a three-column grid.
- Stable team order and stable card positions throughout training.
- A compact public header shows phase, timer, and pause/countdown status.
- Admission QR can be expanded by the facilitator; keep it away from active creature visuals.
- No administrative reset, calibration, score-editing, or test-input buttons on the real projected view.

### 5.2 Each training card

Each card contains:

1. Large team number plus identity color/accessory.
2. The team's creature, with exactly the configured number of controllable limbs.
3. Legible limb IDs matching the IDs on phones.
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
| Paused/disconnected | Clear status; disable stroke submission | Freeze/neutralize the limb; retain its identity and seat |

Use a brief, localized green glow rather than repeated full-screen flashes. Approximately 200–350 ms is an initial visual timing to test, not a measured requirement. Preserve a checkmark/readiness indicator after the glow fades so success remains legible.

Do not make the whole card green when only one player succeeds. A facilitator must still be able to identify the other players who have not succeeded.

## 6. Phone controller and onboarding

### 6.1 Join behavior

The QR code opens the public participant URL and identifies the session. Team assignment is entered by the player from a number the facilitator distributes.

- Accept only a configured, open team with an available seat.
- Explain invalid, nonexistent, full, or locked teams.
- Never create a new team from a mistyped number.
- Never silently redirect someone to another team.
- Allocate a seat atomically so two simultaneous joins cannot take the same limb.
- Show an unmistakable confirmation: **Team 4 · Limb 2**, matching classroom identity.
- Give a session-scoped persistent player identity and resume token, independent of the transient socket ID.
- A page refresh/reconnect should restore that identity and its assignments. A second tab must not create a duplicate active controller for the same seat.

No personal name, university account, or email is necessary.

### 6.2 Onboarding sequence

1. Confirm team and limb.
2. Tap **Enable motion**.
3. Run a short capability check and show a comprehensible pass/failure result.
4. Show how to hold the phone in portrait orientation, screen facing the player at a comfortable angle.
5. Capture a brief stationary reference for calibration.
6. Show an animated demonstration of that player's assigned movement.
7. Have the player perform approximately three practice attempts, with useful feedback.
8. Enter the controller; maintain access to the same motion demonstration.

Calibration should adjust recognition to a comfortable movement, not force the person to reach a particular distance. The 50 cm boundary is a participant instruction, not a measured coordinate threshold.

### 6.3 Controller layout

Keep these elements visible without scrolling:

- Team number/color/accessory and limb ID.
- Small creature view with that person's limb highlighted.
- Assigned directional arrow and looping demonstration, with a way to stop/replay the demonstration.
- Large thumb-accessible **Hold to paddle** button.
- Current recognition status and simple local feedback.
- Paused/disconnected/reconnecting status.
- Optional sound/haptics preferences where supported.

The same assigned movement remains visible throughout all phases. Essential state must be conveyed through visuals and text, including on silent iPhones.

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

Assignments are made once. Recalibration changes the recognition reference/thresholds, not the gesture identity or assigned limb.

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

Suggested feedback:

| Event | Required feedback | Optional enhancement |
| --- | --- | --- |
| Press | Clear depressed-button/armed state | Very short Android pulse, only if it does not interfere with recognition |
| Hold/move | Local visual movement indicator | None continuously |
| Local recognition | Immediate labeled acknowledgment | Brief pulse after recognition has latched |
| Server acceptance | Green check/highlight | Short sound if enabled |
| Wrong/incomplete attempt | Clear, non-punitive text after release | Quiet optional sound |
| Team item collection | Authoritative score update and item pop | Shared display sound; avoid vibrating every player mid-stroke |

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
- A network disconnect never changes team capacity, reallocates that player's limb, or grants the remaining players extra power.
- On pause, resume, reconnection, mode change, or reset, require a fresh press before accepting a new gesture.
- Deduplicate facilitator commands so an acknowledged retry cannot accidentally reset twice.

## 10. Creature movement and game rules

### 10.1 Shared stroke semantics

**Implementation default:** a validated, server-accepted completed stroke produces one fixed propulsion impulse. Intermediate movement drives limb animation, not a second source of propulsion.

This deliberately keeps both network presentation modes equivalent:

- `continuous`: intermediate limb/progress updates plus the completed-stroke event.
- `stroke_events`: completed-stroke events and an animated stroke on receipt, without intermediate updates.

Do not award propulsion once from streamed progress and again from stroke completion. Network frame count, sample rate, phone brand, gesture force, and haptic availability must not increase propulsion.

### 10.2 Limb layout and team-size normalization

Suggested layouts:

| Team size | Layout |
| --- | --- |
| 4 | Two left-side and two right-side paddles |
| 5 | Two left-side and two right-side paddles, plus a center-rear paddle/tail |
| 6 | Three left-side and three right-side paddles |

Assign stable limb IDs and maintain them across all views and phases. Do not change creature topology after assigning players without an explicit session/roster reconfiguration.

Let `N` be the configured number of limbs for the current round:

- Each accepted stroke contributes forward impulse proportional to `1/N`.
- For turning, normalize the total capacity of the left and right banks equally. Center-rear limbs add forward propulsion without a turning bias.
- A complete stroke cycle from every assigned limb should produce comparable total forward impulse for a 4-, 5-, or 6-player team.
- Equal left-bank and right-bank participation should cancel turning, including for the five-limb layout.
- Disconnection does not reduce `N` or inflate the power of remaining players.

This prevents a built-in raw-power advantage for larger teams; it does not guarantee equal human coordination difficulty.

Use a simple, damped 2D simulation with configurable forward impulse, speed limit, linear drag, angular impulse, and angular damping. Integrate using a fixed server timestep, independent of message arrival rate and display frame rate.

### 10.3 Straight swimming

- Give each team a clearly labeled lane.
- Lock heading and lateral position. Strokes advance the creature toward a shared finish distance.
- Use identical course distance and normalization rules.
- Rank finishers by authoritative server finish time.
- Continue after the first finisher so the other teams can finish.
- End when all teams finish, the time limit is reached, or the facilitator ends the round.
- At timeout, rank unfinished teams by distance; display that they did not finish.
- Freeze a finished team's simulation progress without removing its players from the session.

Under additive propulsion, straight swimming mainly tests individual gesture execution and contribution to shared progress. Do not invent an unexplained synchrony bonus or claim that perfect inter-player rhythm is mathematically required.

### 10.4 Free-water practice and collection

- Use a shared arena with all teams visible.
- Use the same limbs, assignments, recognizer, and stroke power as the straight race.
- Unlock turning: left-side strokes tend to turn toward the right; right-side strokes tend to turn toward the left. Choose and document a consistent coordinate/yaw convention.
- Use damping and bounded turning so a single accidental stroke does not create uncontrollable spinning.
- Allow overlap between creatures; disable inter-team collisions.
- Keep creatures within the arena using readable boundary behavior, such as soft wall response, rather than wrapping to the opposite side.
- Offer an unscored 15–20-second steering familiarization. Reset positions, items, and scores before the scored collection countdown.

Collection rules:

1. Contact is evaluated against the creature body's 2D collision footprint, not the apparent ends of decorative limb sprites.
2. On contact, the server removes the item exactly once and increments one team's score.
3. Broadcast the authoritative collection event; animate a pop/sparkle and score update.
4. If two creatures contact the same item in the same simulation tick, use nearest-center distance, then a stable team-ID tie-break for exact equality.
5. Initial items and team starting positions should offer comparable opportunities. Do not spawn an item already inside a creature.
6. Default: maintain approximately 10–12 items, replacing a collected item after a short configurable delay, initially one second. Replacement is an implementation default; disappearance on collection is confirmed.
7. Winner is the highest score when active time expires. Equal scores can share a rank; do not introduce a hidden tie-break.

Use a seeded layout generator for repeatable tests. Exact seed selection is a facilitator/configuration detail.

## 11. Art direction and asset contract

### 11.1 Visual target

Create an original, playful cartoon pond world with chunky silhouettes, expressive faces, painted shading, and a 2.5D feel. The reference is the broad visual character of Plants vs. Zombies: approachable shapes, exaggerated personalities, and readable gameplay.

The proposed creature is a round lily-bulb/pond creature with oversized leaf paddles. This character design is an implementation/art default; the many-limbed team body and cartoon 2.5D direction are confirmed.

- Mostly overhead camera with a slight illustrative angle.
- Calm turquoise water; decorative reeds, lily pads, and flowers mainly at arena edges.
- Raised/shaded bodies, soft water shadows, and readable wakes.
- Distinct team body colors plus numbers/accessories so identity does not rely on color alone.
- Bright golden bugs or glowing seed pods as collectibles.
- Friendly rounded controls, illustrated wood/sign details, and high-contrast readable text.

Keep the simulation plane and collection footprints clear. Decorative depth must not hide a limb or make object contact look spatially incorrect.

### 11.2 Modular creature assets

Require independently renderable layers/components:

1. Body and face.
2. Each paddle/limb, with a defined attachment point and pivot.
3. Optional center-rear paddle/tail for five-player teams.
4. Team accessory/color treatment.
5. Water shadow.
6. Wake/splash particles.
7. Recognition highlight.
8. Limb-ID label layer, readable regardless of body rotation.

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
| Round | Round ID, phase, scoring enabled, run status, seed, active duration, timer state, team simulation records, finish records, items |
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
| Server → relevant clients | `item.collected` | Item ID, collecting team, new score, round ID |
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
- Calculate scored time from active time only; pausing must not consume the remaining round.
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
| Refresh and reconnect | Same team, limb, gesture, and seat |
| Second controller for the same identity | No duplicate active input owner |
| Duplicate stroke/retry | One impulse and one counter increment |
| Old round/session/input/calibration event | Rejected without state change |
| Pre-pause stroke delivered after resume | Rejected using the changed input epoch, even though round ID is unchanged |
| Pause/countdown/finished input | No propulsion or score change |
| Pause for 20 seconds | Remaining scored time unchanged |
| Four-/five-/six-limb complete cycles | Comparable total forward impulse; no unexplained bank-turning bias |
| One disconnected player | No power increase for remaining players |
| Switch continuous/event modes | Same accepted-stroke power and scoring |
| Two teams contact one item simultaneously | One item removal and one award |
| Race timeout | Finishers ranked by time; unfinished teams clearly ranked by distance |
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

The straight race is the core deliverable. If time is limited, deliver a reliable join → train → discuss/pause → straight race → results experience before polishing the optional collection mode.

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
5. Exact activity time budget and final discussion-question copy.

The following must remain stable unless the user explicitly changes the design:

- One player, one limb, one assigned movement throughout the activity.
- Assigned team-number joining.
- Seated, compact movement.
- Hold for the working stroke; release for the return.
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

