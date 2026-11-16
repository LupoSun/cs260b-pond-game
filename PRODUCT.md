# Product

## Register

product

## Users

- **Participants (up to 30 students):** seated in a classroom, holding their own phone in one hand, looking mostly at the shared projector. They glance at the phone for a second at a time, often mid-motion. They did not choose this app and have about a minute to learn it.
- **Facilitator:** runs the activity from a laptop (`/control`) while talking to the room. Needs predictable, clearly labeled operation under time pressure.
- **The room:** everyone reads the projector (`/screen`) from several meters away, in mixed lighting.

## Product Purpose

A classroom shared-body game accompanying discussion of homuncular flexibility (Won et al., 2015). Each team collectively drives one swimming pond creature; each phone controls one limb through a compact hold, sweep, release motion. Success is a room that understands its odd control mapping within a minute, feels its own strokes land on the shared creature, and gets loud about the race.

Canonical behavior lives in `CS260B_Pond_Game_Implementation_Spec.md`.

## Brand Personality

Loud, punchy, generous. An American comic page that happens to be a game: thick ink, halftone dots, speed lines, starbursts, onomatopoeia. It should feel like a game show the class walked into, not a research instrument or a dashboard.

Reference supplied by the project owner: a pop-art comic page with black-bordered panels, halftone fills, radial bursts, speech bubbles, and chunky outlined lettering (HEY! POW! BOOM! WHAM!) in saturated cyan, hot pink, yellow, red, and orange.

## Anti-references

- The previous interface: dark teal dashboard panels, thin borders, system font, quiet status text.
- Generic SaaS admin styling on any participant-facing surface.
- Soft, blurred, glassy, or pastel "wellness" visuals.
- Decoration that hides state: a starburst is never allowed to cover a limb label, a clock, or a readiness mark.

## Design Principles

1. **The projector is the stage.** The shared display carries the spectacle; phones stay a single obvious control.
2. **State before style.** Held, accepted, paused, disconnected, and calibrated must each read at a glance, without relying on color alone, sound, or haptics.
3. **Every accepted stroke gets a reaction.** Feedback is local to the limb that earned it and never floods the whole card or screen.
4. **One page, three voices.** Participant and projector surfaces are full comic; Mission Control wears the same ink and type but stays calm, dense, and legible.
5. **Honest about what is real.** Development-only simulated inputs stay labeled; procedural artwork is described as procedural.

## Accessibility & Inclusion

- Text contrast at or above WCAG AA (4.5:1) on every surface, including text on saturated panels.
- `prefers-reduced-motion` removes looping, entrance, and impact animation while keeping every state visible.
- Team identity is never color-only: team number, name, and accessory always accompany color.
- Success is never color-only: a persistent checkmark follows the green cue.
- Haptics and audio are optional; visuals carry all essential states.
- Phone controls stay large and thumb-reachable for seated, one-handed use.
