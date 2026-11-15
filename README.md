# CS260B Shared-Body Pond Game

A classroom game about learning unfamiliar avatar controls. Teams of 4–6 collectively operate one swimming creature, with each participant using a phone to control one limb.

Players join by QR code and assigned team number, learn their own motion during a projected training session, then compete in a straight swimming race. An optional second round adds steering and item collection.

## Project status

**Specification and implementation handoff.** Game code, final artwork, and physical-device validation have not been added yet.

The runtime target is a Linux server managed over SSH, with three browser interfaces:

- **Participant controller:** phone onboarding, motion input, and individual feedback.
- **Classroom display:** team training cards, races, collection, and results.
- **Mission Control:** facilitator phase controls, readiness inspection, pause/resume, and scoped resets.

## Start here

| File | Purpose |
| --- | --- |
| [Implementation specification](CS260B_Pond_Game_Implementation_Spec.md) | Complete requirements, defaults, interfaces, recognition design, game rules, architecture, tests, and deployment handoff. |
| [Agent instructions](AGENTS.md) | Instructions for the agent implementing the project. |

The specification distinguishes confirmed requirements, proposed engineering defaults, and assumptions requiring real-device validation.

## Implementation priorities

1. Validate the hold–sweep–release recognizer on an actual iPhone and Android phone.
2. Connect one phone to one live projected limb.
3. Build team joining, training cards, and Mission Control.
4. Deliver a reliable straight race with normalized team power.
5. Add optional free-water steering and collection.
6. Integrate modular artwork and rehearse on the classroom network.

See specification Section 15 for milestone details and Section 14 for acceptance criteria. If hardware is unavailable, continue independent work while reporting the missing physical-device validation clearly.

## Core design constraints

- At most 30 players; 4–6 participants per team.
- One player, one limb, one assigned motion throughout the activity.
- Compact seated movements; hold for the working stroke and release for the return.
- Local recognition with authoritative server scoring and state.
- Stable identities and assignments across reconnects.
- Equivalent scoring in continuous-preview and completed-stroke network modes.
- Original cartoon pond artwork with a 2.5D appearance and independently animated limbs.
- Visual feedback works on every supported phone; haptics are optional.

## Research context

The activity accompanies discussion of [*Homuncular Flexibility in Virtual Reality* — Won et al. (2015)](https://doi.org/10.1111/jcc4.12107).

This is an educational group activity, not a replication of that study: learning to operate an altered body and coordinating several people are related but distinct questions.

## Deployment

Hosting configuration, actual SSH destination, HTTPS endpoint, and device-test results will be documented during implementation. No production credentials are stored here.
