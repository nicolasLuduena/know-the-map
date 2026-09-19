# Product

## Register

product

## Users

The primary consumer of Know the Map is an agent working in a codebase that
depends on the indexed package. It reads the index over MCP while doing a real
task, asks what a component does, and follows a claim to the exact source lines
when it needs proof. It has a limited context window and no time to read the
package from scratch.

The secondary user is the engineer who configures and reviews the index. They
name the package and version to index, choose the provider and model, check the
cost and coverage of a run, and spot-check claims against the source.

## Product Purpose

Know the Map is a local, private, version-exact index of the code a project
depends on. It divides a package into components, binds every interpretation to
the evidence that supports it, validates each claim against the files, and
serves the result to agents over MCP.

The product succeeds when an agent with the index attached uses less context on
a real task than one without, can distinguish evidence from inference, and
catches a wrong claim by reading the lines behind it.

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
