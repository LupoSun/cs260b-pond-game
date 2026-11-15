# Agent instructions

## Project context

This repository is part of the wider CS260B project. It contains the implementation handoff for a classroom shared-body pond game.

Read `CS260B_Pond_Game_Implementation_Spec.md` before implementing or changing product behavior. It is the canonical design document. `README.md` is the entry point.

## Scope and decisions

- Preserve confirmed requirements in the specification.
- Treat labeled engineering defaults as configurable starting points, not independently approved facts.
- Keep unvalidated assumptions visible. Do not present a prototype or synthetic test as proof of physical-phone behavior.
- When the user changes a design decision, update the specification and relevant implementation together.
- Repository setup does not itself authorize building or deploying the entire game. Begin those tasks when requested.

## Implementation sequence

Follow specification Section 15:

1. Physical-phone sensor/recognition spike.
2. One phone controlling one live limb.
3. Team onboarding, training grid, and Mission Control.
4. Straight race.
5. Optional free-water collection.
6. Artwork, feedback, deployment, and classroom rehearsal.

If real phones are temporarily unavailable, continue work that does not depend on physical validation and report that test as outstanding.

## Non-negotiable behavior

- A player keeps the same team, limb, and movement assignment throughout the activity.
- Join the facilitator-assigned team explicitly; do not silently reassign people.
- Count at most 30 player identities; host and classroom display connections are not players.
- Recognize at most one successful stroke per button press.
- Ignore the return movement while the button is released.
- Keep movement compact for seated participants; do not claim centimeter tracking from inertial sensors alone.
- Classify motion locally. Keep game state, scoring, phase, timing, and collection authoritative on the server.
- Deduplicate stroke events and facilitator commands.
- Reject stale input after pause/resume, reconnect, reset, or phase changes.
- Preserve identities and assignments across reconnects and scoped resets.
- Do not give a team more power because a participant disconnects.
- Preserve scoring equivalence between the two network presentation modes.
- Treat sensor-ready, calibrated, and successfully performed a stroke as separate statuses.
- A public classroom display cannot perform host actions.

## Platform and feedback constraints

- Validate actual sensor readings in Safari on iPhone and Chrome on Android.
- Do not quietly substitute tilts or touch input for the specified physical sweeps; identify the fallback explicitly.
- Do not rely on general programmable Taptic Engine access from iPhone Safari.
- Haptics and audio must be optional. Visual feedback must communicate all essential states.
- Do not feed vibration or touch-button transients into gesture recognition.
- Keep development-only simulated inputs clearly labeled and disabled by default in classroom deployment.

## Verification and handoff

Implement the meaningful invariants and integration checks in specification Section 14. Measure network/load behavior instead of asserting universal latency tolerance.

Keep a record of tested device/browser versions, outstanding physical tests, placeholder artwork, and known limitations.

Supply setup, build, test, deployment, and facilitator runbook instructions with the implementation. Use actual tested dependency versions and never invent server addresses or credentials.

## Source and deployment hygiene

- Commit only relevant source and project documentation.
- Keep credentials, local environment values, generated dependencies, and runtime logs out of Git.
- Use the user's Linux server as the runtime target; this is a source repository, not a static replacement for the multiplayer server.
- Do not publish, change repository visibility, or deploy new services beyond what the user requests.
