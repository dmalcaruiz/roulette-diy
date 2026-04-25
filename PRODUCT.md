# Roulette DIY — Product Vision

## What this app is

Roulette DIY is a web tool for building **shareable, multi-step, branching interactive experiences**. Wheels and lists are *components inside an Experience*, not standalone products.

The hero noun is **Experience**. A single roulette wheel is just a one-step Experience.

## Why this framing (and not "another spin-the-wheel site")

Standalone wheel sites — wheelofnames.com, pickerwheel.com, spinthewheel.io — own the SEO for "spin a wheel" and have zero-friction UX (no signup, 30 seconds end-to-end). Competing on that surface is a losing fight: they rank #1, are free, and the job is done before the user would ever look for an alternative.

What those sites cannot do is **branching**: "wheel A's result determines whether you spin wheel B or C." That's the wedge. Multi-step, conditional, persistent flows are what Roulette DIY is for.

## Target user (one ICP, picked deliberately)

**Twitch streamers running interactive segments with their audience** (50–500 concurrent viewers, streams 2+ times per week, already on OBS, already runs "chat picks my X" bits).

The pain: every interactive segment is cobbled together — a basic wheel site + screen-share + manual list management in chat — with no persistence, no branching, no result history. 10 minutes of setup per stream.

Secondary ICP we may pivot to if streamers don't bite: teachers / facilitators running classroom or workshop activities. We do not build for both at once.

## Goals

1. **Make Experience the front door.** The primary CTA on the app is "build an Experience," not "create a wheel."
2. **Anonymous-first.** A user can land, build, publish, and share *without signing in*. Account creation is a value prompt, not a wall.
3. **Streamer-grade play surface.** A clean `/e/{id}/play` URL with no chrome, auto-advance through branches, optional transparent background — the kind of thing a streamer drops into OBS once and uses for every stream.
4. **Result capture.** Every play of an Experience writes a result row. This becomes the creator's results dashboard later.
5. **First 10 paying users by manual outreach** — not by feature growth.

## Non-goals (anti-features)

- We are **not** competing with wheelofnames.com on "I need to pick a name in 30 seconds." Users who land on us with that intent should still succeed (one-step Experience), but the product is not optimized for that job.
- We are **not** building creator monetization, Stripe, or pro tiers until 10 active users exist. Don't build the pricing page before the customers.
- We are **not** building for both streamers and teachers simultaneously. One ICP, one set of feature priorities.
- We are **not** maintaining standalone-Roulette publishing as a separate first-class flow. Publishing happens at the Experience level. A bare published wheel becomes a one-step Experience.

## Differentiators (concrete, defensible)

| What | Why it matters |
|---|---|
| **Branching, multi-step Experiences** | The thing wheelofnames cannot trivially copy. Core wedge. |
| **Anonymous-first creation + publish** | Removes the friction tax that makes us un-competitive on cold landings. |
| **OBS-friendly play URL** (chromeless, auto-advance, transparent bg option) | Concrete streamer feature — drop it into OBS once, use it forever. |
| **Result capture** (per Experience play) | Lets creators see what their audience picked. Foundation for future monetization. |
| **Persistent, account-linked Experiences** | Streamers don't rebuild every stream — and the data follows them once they sign in. |

## Strategic constraints (decisions already made)

- **Keep the Feed and public profiles.** Even though they're unproven, we keep them visible — they're cheap to maintain and they're the social surface that makes the app feel alive when creators do arrive. Don't optimize for them yet, but don't hide them.
- **Kill the signup wall.** Auth is optional until the user hits a value moment (publishing from a new device, first view of their published Experience, hitting 3 Experiences).
- **One ICP at a time.** Streamers first. If 8 weeks of manual outreach doesn't yield 10 paying users, pivot ICP — not product.

## How to decide whether a feature ships

A feature ships if it makes one of these true:

1. The streamer wedge gets sharper (OBS integration, branching ergonomics, result capture, on-stream UX).
2. Friction on first creation drops (anonymous flows, fewer clicks before "publish").
3. A specific, named creator we are talking to has asked for it.

A feature does **not** ship just because it would be nice, makes the codebase more elegant, or because a competitor has it. The Experience builder is already complex enough; surface area is the enemy.

## What success looks like (90 days)

- 10 active Twitch streamers using a published Experience on stream at least weekly.
- 3 of them paying for a "Creator Pro" tier (custom branding, results dashboard, webhook on result).
- One unprompted referral from a paying user to another streamer.
- A clear answer to "what do these 10 streamers have in common" — that's the wedge for the next 100.

If we don't hit those numbers, the ICP is wrong; the product probably isn't.

## Open strategic questions

- **Does the feed earn its keep, or should it become a creator-only surface?** Keep watching engagement. If it stays a graveyard once we have 50+ creators, repurpose it (e.g. trending Experiences from streamers we follow).
- **Does the streamer wedge generalize to teachers, or is it a different product?** Don't answer this until streamer ICP is validated or rejected.
- **Where does the Experience builder cap out?** Branching today is "if result = X, go to step Y." Eventually creators will want loops, conditional state, scoring. Don't build that until a real creator asks twice.

---

*This document supersedes any earlier framing of the app as "create wheels and share them." That framing is what we're pivoting away from. When in doubt about a product decision, the question to ask is: **does this make the streamer's interactive segment better?***
