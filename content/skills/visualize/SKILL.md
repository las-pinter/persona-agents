---
name: visualize
description: Turn this session's work into one visual document - a graphic-first HTML one-pager by default, or slides or Markdown - saved in the project notes. Run it with /companion-agents:visualize.
argument-hint: "[html|slides|md] [what to show]"
disable-model-invocation: true
---

## Platform branch

If your system context says `Running in Pi`, the `/visualize` message carries
the argument. Use it as the argument below; the `$ARGUMENTS` text in this file
does not apply.

# Visualize

## Purpose

Make one document that shows what happened, so a reader understands it at a
glance. Lead with graphics; keep text short. Write exactly one file and print
its path.

The argument: `$ARGUMENTS`

When the harness has not filled in that line and it still reads as a
placeholder, take the argument from the owner's command text in the
conversation; when there is none, the argument is empty.

## When to Run

Run this skill only when the owner types the command. Run it yourself, in this
session; do not hand it to a subagent.

## Step 1: Read the Argument

The argument is free text. It may name a format, a focus, or both. It may be
empty.

| Argument holds | Meaning |
|----------------|---------|
| nothing | `html` one-pager about this session |
| `html`, `page`, `one-pager` | `html` |
| `slides`, `deck`, `presentation` | `slides` |
| `md`, `markdown` | `md` |
| any other text | the focus: what to show, a time span, an audience, extra data |

A format word and a focus can come together: `slides the review flow for the
team`. A request for any other format (`svg`, `pdf`, `pptx`, a poster) is best
effort: make it only when you can with no new tool or dependency. Otherwise say
so in one line and make the nearest named format.

## Step 2: Collect the Evidence

Default scope is the current session:

| Source | Holds |
|--------|-------|
| Session context | The request, the turns, the tool results, the outcome |
| Task notes | `<project notes>/tasks/` files this session worked on: plan, step status, decisions |
| Study | The study the task notes link: goal, decisions, tasks, risks |
| Git | This session's commits (`git log`), their diff stat, the working-tree state |
| Test and check output | The last run of each gate this session made |
| Review | The verdicts and finding counts of this session's reviews |

The session start text names the project notes folder and the session id.

The focus may widen the scope, for example "the last week" or "the whole
study". Then also read the session logs (`<project notes>/session-logs/`), the
studies, and the git history the span covers. Session cost, token counts,
compactions, and permission asks are out of scope unless the focus asks for
them.

### Honesty

- Show only what the evidence holds. Every number comes from a command output,
  a file, or a counted list.
- Never invent a metric, a duration, or a percentage to fill a chart.
- Mark a part that was not checked as **not checked**, and a gap as
  **unknown**. Leave out a section with no evidence.
- Times come from commits, file stamps, and the session; when the order is
  known but the time is not, draw a sequence, not a clock.

### Leave Out

The document is shared with other people. Leave out:

- tokens, keys, passwords, connection strings, and the value of any secret
  environment variable;
- email addresses and account ids;
- absolute paths outside the project and the notes folder: write paths
  relative to the repository root, or `~/agent-notes/...`.

The document is a durable artifact: follow the **persona-free-documents**
skill. Use no persona name, theme word, or title for the owner.

## Step 3: Plan the Story

Before you write, choose:

1. **The headline:** one sentence that says what the session achieved.
2. **Three to seven sections**, each answering one question a reader asks:
   - What was the goal?
   - What is the result? (done, partly done, blocked)
   - How did it unfold? (the sequence of steps)
   - What changed? (areas, files, commits, before and after)
   - What was decided, and why?
   - How was it verified? (tests, gates, review verdict)
   - What is open, and what is next?
3. **One graphic per section**, chosen for what the section must make clear.

A focus from the argument replaces this default outline with the sections that
focus needs.

### Choosing the Graphic

Pick the form that fits the content, not the most familiar one. Any graphic
that makes the content easier to grasp is welcome.

| To show | Use |
|---------|-----|
| A sequence of steps or events | A timeline, a numbered path, a swimlane |
| A process, a flow of control or data | A flow diagram with arrows, a sequence diagram |
| States and transitions | A state diagram, a stepper |
| Structure: modules, folders, components | A box-and-arrow map, a tree, nested blocks, a treemap |
| Where a change landed | A map of the codebase with the touched areas highlighted |
| Before and after | Two panels side by side, a highlighted diff of the idea |
| Proportions and sizes | Bars, a stacked bar, a waffle grid; not a pie with many slices |
| A status or verdict | A badge, a traffic-light pill, a check list with icons |
| Progress toward a goal | A progress bar, a ring gauge, a filled step track |
| Counts that matter | Large stat tiles with a short label |
| A decision and its reason | A card: the choice, the options set aside, the reason |
| Trade-offs | A two-axis grid, a comparison table with icons |
| Risk | A likelihood-impact grid |
| A concept that is hard to picture | A small metaphor drawing, an annotated sketch |

Each graphic carries a short title that states its point ("Two of three gates
were green before the fix"), not only a topic ("Gates").

## Step 4: Write the File

### Path

`<project notes>/visuals/<YYYY-MM-DD>/<HHMM>-<slug>.<ext>`

- Take the date and the time from the `date` command (`date +%F`,
  `date +%H%M`).
- The slug is two to five kebab-case words from the focus or the headline, for
  example `visualize-command` or `session`.
- The extension is `.html` for `html` and `slides`, `.md` for `md`.
- Create the day folder when it is missing. When the file exists, add `-2`,
  `-3`, and so on to the slug. Never overwrite.

### Every Format

- One self-contained file. No request to the network: no CDN script, no web
  font, no remote image, no `http://` or `https://` URL in a `src`, an `href`
  to a stylesheet, an `@import`, or a `url()`. A plain link a reader clicks is
  allowed.
- The header names the project, the date, the session id, and the headline.
- Text is short: a label, a caption, one or two sentences per block. Put
  detail in a collapsible `<details>` element, not in the main flow.
- English, plain words, the owner's own terms for things.

### `html` (the default one-pager)

Structure:

- A header with the headline, the outcome as a status badge, and three to five
  stat tiles (for example commits, files changed, tests passing, review
  verdict).
- The sections from Step 3, each led by its graphic.
- A footer with the evidence sources the page used.

Craft:

- Semantic HTML: one `<h1>`, then `<h2>` per section, `<main>`, `<section>`,
  `<figure>` with `<figcaption>`.
- Inline `<style>` with CSS custom properties for the colours, spacing, and
  radii. A system font stack; a monospace stack for code and paths.
- A deliberate palette: one accent colour and one or two supporting colours,
  with neutral greys. Status colours (green, amber, red) only for status.
  Readable contrast for text (WCAG AA). Never let colour alone carry meaning:
  add an icon, a label, or a pattern.
- Light and dark themes through `prefers-color-scheme`. Set the page
  background and text colour explicitly in both.
- A layout with CSS grid and flexbox that reads on a phone (about 360 px wide)
  with no horizontal scroll, and uses the width of a large screen. Fluid type
  with `clamp()`.
- Graphics as inline SVG with a `viewBox`, `width: 100%`, `role="img"`, a
  `<title>`, and a `<desc>`. Lay out boxes and text with CSS where you can;
  draw lines, arrows, and shapes in SVG. Keep labels inside their shapes and
  leave space between them. Draw with `currentColor` and the custom
  properties, so the graphics follow the theme.
- Each chart states its numbers in text too: on the marks, in a caption, or in
  a small table.
- Motion is optional and subtle. Respect `prefers-reduced-motion`.
- A print stylesheet: white background, no fixed elements, no break inside a
  figure.
- Script only when it helps (a theme toggle, a tab, a hover detail). The page
  reads fully with script off.

### `slides`

- One `.html` file. Each slide is a `<section>` that fills the viewport, one
  idea per slide, six to twelve slides.
- The first slide holds the headline; the last holds what is next.
- Arrow keys, Space, Page Up, and Page Down move between slides; the URL hash
  holds the slide number; a slim progress bar shows the position.
- With script off, the slides read as a scrolling page.
- The print stylesheet puts one slide on each page.
- The `html` craft rules above apply to every slide.

### `md`

- GitHub-flavoured Markdown that reads well in a viewer that renders it.
- Graphics as fenced `mermaid` blocks (`flowchart`, `sequenceDiagram`,
  `stateDiagram-v2`, `timeline`, `gantt`, `pie`, `quadrantChart`), tables, and
  task lists. One graphic per section.
- A status line near the top with the outcome; a short table of the key
  counts.
- Detail inside `<details>` blocks.

## Step 5: Check and Report

1. Read the written file once. Check that every section leads with a graphic,
   that the text stays short, and that every number traces to the evidence.
2. Search the file for the Leave Out items and for `http://` and `https://`
   in a `src`, a stylesheet `href`, an `@import`, or a `url()`. Fix each hit.
3. Print the absolute path of the file, and one line that says what it shows.
   Do not open the file.

## Rules

- One run writes one file, in the visuals folder only. Change no other file.
- Do not commit the file; the notes folder is not the repository.
- Do not start a review or a subagent.

## Related Skills

- **persona-free-documents** — the document is a durable artifact.
- **project-notes** — the notes folder, the task notes, and the studies.
