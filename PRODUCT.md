# Product

## Register

product

## Users

Know the Map is for capable engineers and technical leads reviewing complex,
unfamiliar, stacked, or agent-generated changes. They are usually working under
time pressure and need to reconstruct enough of a system to make a responsible
approval decision without reading the repository from scratch.

Their primary tasks are to understand how a repository is organized, determine
what a change means beyond its textual diff, check whether established
assumptions still hold, follow important claims back to code, and record durable
human knowledge for the next review.

## Product Purpose

Know the Map is a local-first repository wiki and semantic review workspace. It
connects exact code evidence with human and AI interpretations, detects when
those interpretations drift from the code, and uses the resulting knowledge to
explain a change as a transition between two understood system states.

The product succeeds when a reviewer spends less time reconstructing system
state, can distinguish evidence from inference, and knows what must be verified
before approving a change.

## Brand Personality

Calm, grounded, and systemic.

The product should feel like an excellent staff engineer orienting a capable
peer: precise without being pedantic, curious without pretending omniscience,
and deep without performing complexity. It should make consequential changes
clear without making every change feel alarming.

## Anti-references

- Generic AI-review dashboards organized around scores, chat bubbles, and
  automated verdicts.
- Cyberpunk developer tools with glowing gradients, decorative terminals, or
  constant high-alert color.
- Dense observability dashboards that present every fact with equal visual
  weight.
- Diff viewers that add prose beside hunks without explaining the surrounding
  system.
- Wiki interfaces that bury evidence beneath long generated essays.
- Novel interaction patterns that make experienced engineers relearn familiar
  navigation, filtering, code reading, or review controls.

## Design Principles

1. **Lead with the changed understanding.** Show what the reviewer previously
   believed, what the code now suggests, and what remains unresolved.
2. **Make evidence one action away.** Every important interpretation or review
   claim should reveal its exact source without losing the user's place.
3. **Reveal complexity progressively.** Begin with the system map and important
   consequences; load component detail, interpretations, and code on demand.
4. **Preserve human authority.** User notes, corrections, and explicit decisions
   remain visible and cannot be silently overwritten by AI output.
5. **Use attention proportionally.** Reserve strong emphasis for the current
   focus, changed assumptions, and blocked decisions—not routine metadata.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All core workflows must be operable by keyboard, with
visible focus, logical reading order, semantic landmarks, and non-color-only
status communication. Respect reduced-motion preferences. Code, topology, and
before/after views must remain understandable under common color-vision
deficiencies and at 200% zoom.
