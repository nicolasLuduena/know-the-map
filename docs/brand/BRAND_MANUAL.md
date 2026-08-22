# Know the Map by Bleentr — Brand Manual

Version 1.0 · August 2026

## Brand idea

Know the Map is Repository & Change Intelligence for people who need to understand a system before approving how it changes. It builds a persistent, temporal model of a repository—structure, dependencies, flows, intent, invariants, ownership, tests, and architectural history—then explains a change as a transition between two system states.

**Brand promise:** Give reviewers the mental map they need without making them reconstruct the whole system from scratch.

**Primary tagline:** Understand the system behind the change.

## Positioning

For engineers and technical teams reviewing complex, stacked, or agent-generated changes, Know the Map is the repository and change-intelligence layer that shows what the system was, what a change alters, and what the system becomes. Unlike diff summarizers and generic AI reviewers, it grounds review in a persistent, evidence-aware model of architecture and history.

### Category

Repository & Change Intelligence. Do not lead with “AI code review.” AI is an execution capability; comprehension is the product.

### Message hierarchy

1. Understand the system, not just the diff.
2. See architecture and history around every change.
3. Review a semantic transition, not isolated hunks.
4. Reduce the system state reviewers must reconstruct mentally.
5. Bring the harness that fits your workflow; the product remains the intelligence layer.

## Taglines

- Primary: **Understand the system behind the change.**
- Campaign: **Don’t just read the diff. Know the map.**
- Repository view: **See the system. Follow its history.**
- Change view: **Know what it was. See what it becomes.**
- Agent-era: **Agents write the code. You still need to know the map.**

Avoid promises such as “AI that reviews every PR,” “instant codebase understanding,” or “never review code again.”

## Personality

- Deep, not dense: reveals the underlying model without performing complexity.
- Grounded, not magical: points to code, history, tests, and evidence.
- Calm, not alarmist: surfaces risk in proportion to evidence.
- Precise, not pedantic: uses the exact technical term, then makes it legible.
- Curious, not omniscient: asks the review question that unlocks understanding.
- Systemic, not reductive: connects a local edit to architecture and trajectory.

## Voice and tone

Write like an excellent staff engineer orienting a capable peer. Lead with the system-level consequence, then show evidence. Prefer active verbs and concrete nouns. Separate observation, inference, and question. Say “This introduces SessionStore between AuthService and persistence” rather than “The AI detected a significant architectural modification.”

Tone shifts: concise and orienting in navigation; explanatory in repository views; careful and evidence-led in review findings; neutral in alerts; confident but bounded in marketing.

## Visual idea: the living topology

The identity depicts a stable system map with one transition under examination. Nodes are meaningful entities. Routes are dependencies, flows, or history. The bright Signal node is never decoration: it marks the semantic change, the current point in time, or the reviewer’s focus.

The K-route symbol combines a “K” monogram with a compact topology. Its vertical spine suggests repository history; its branches suggest architecture; its center node marks the change being understood.

## Color

- Deep Ink `#0B1F2A` — primary field, authority, depth.
- Paper `#F5F1E8` — warm reading surface, human comprehension.
- Mineral `#2F7F78` — structural routes, secondary emphasis.
- Signal `#C7F23D` — one change, focus, or transition only.
- Slate `#607680` — secondary text and metadata.
- Fog `#DDE5E2` — boundaries, panels, diagram support.

Default ratio: 60% Paper, 25% Deep Ink, 10% Fog/Mineral, no more than 5% Signal. Never use Signal for paragraphs or large backgrounds. Pair Signal with Deep Ink for readable text.

## Typography

Use Inter for product UI, web, and communications: 700–800 for major headlines, 600 for labels, 400–500 for body. Use JetBrains Mono for commit IDs, symbols, paths, code, evidence labels, and temporal coordinates. Fallback stack: `Inter, Arial, Helvetica, sans-serif`; mono: `JetBrains Mono, ui-monospace, monospace`.

## Logo system

The system includes primary horizontal, stacked, symbol-only, reverse, monochrome, README, social, and favicon variants. Use the horizontal lockup by default. Use the symbol only when the product name is already present or space is constrained.

Clear space is one center-node diameter on every side. Minimum widths: horizontal lockup 160 px digital / 42 mm print; stacked lockup 96 px / 25 mm; symbol 20 px, with the dedicated favicon for 16 px. Do not redraw, rotate, stretch, add effects, recolor individual nodes, highlight more than one node, place on noisy imagery, or separate “by Bleentr” from the lockup.

Bleentr is the umbrella endorsement. “by Bleentr” remains visibly secondary and should not compete with the product name. In product copy, first mention may be “Know the Map by Bleentr”; subsequent mentions use “Know the Map.”

## Imagery, diagrams, and interface

Prefer system views over decorative illustrations: architecture layers, dependency routes, commit trajectories, before/after state, and evidence paths. Use generous empty space and a restrained grid. One accent answers “what changed?” Motion should trace, reveal, or transition; never pulse aimlessly. Avoid brains, robots, sparkles, chat bubbles, circuit boards, glowing neural networks, literal folded maps, pins, globes, and cyberpunk gradients.

## Applications

Web navigation uses the horizontal lockup on Paper or white. README uses the dark banner for strong recognition at repository scale. Social cards pair the mark with the primary tagline and leave room for a release or article title. The social avatar and favicon use the tiled K-route symbol. Product UI should keep the logo quiet; the topology grammar belongs in diagrams, timelines, and change states.

## Governance checklist

- Does the message lead with comprehension rather than automation?
- Is every claim grounded in a system state, history, or evidence?
- Does Signal identify one meaningful focus?
- Is the mark legible at the intended size?
- Is “by Bleentr” secondary but intact?
- Does the design feel calm, technical, and editorial?
- Have generic AI clichés been removed?
