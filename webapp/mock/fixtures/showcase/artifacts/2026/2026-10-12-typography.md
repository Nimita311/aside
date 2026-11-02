---
name: Typography · words with room to breathe
created: 2026-10-12T11:05
attachments: [specimen.md]
---

# A bright idea, clearly expressed

This is Aurora's complete writing specimen. It exercises the real Markdown renderer in the flow, project and action details, artifact reader, and supporting Markdown files.

## A second-level heading creates a chapter

Body text stays useful at a glance. **Strong text** marks the decision; *emphasis* adds a human inflection; ***both together*** makes a phrase stand out. ~~A crossed-out direction~~ records a change, while `inline code` names an exact value such as `Aurora.launch({ quiet: true })`.

### A third-level heading introduces a thought

The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow. Numbers should be easy to distinguish: **0 O · 1 I l · 0123456789 · 1,234.56 · −42 · 24%**.

#### A fourth-level heading holds a detail

Use compact headings for a detail that belongs to its surrounding section.

##### A fifth-level heading stays modest

One short paragraph is enough to show its spacing and weight.

###### A sixth-level heading is a quiet label

The smallest heading still carries a clear hierarchy.

## Lists that carry a plan

- First, make the language clear.
- Then, make the relationship visible.
  - Nested unordered text should keep its rhythm.
  - A second child can hold **bold text** and `code`.
    - Even a third level should remain readable.
- Finally, leave room for the next idea.

1. Read the brief.
2. Compare the options.
   1. Start with the smallest useful change.
   2. Explain the tradeoff in one sentence.
3. Record the decision.

- [x] Build a coherent fictional workspace
- [x] Include short and long content
- [ ] Review every screen at a narrow width

## A quotation creates a pause

> Clear writing begins by making a decision about what the reader needs next.
>
> A quotation can contain **emphasis**, a [labeled project reference](#project/2026-10-12-aurora), and a second paragraph.
>
> > Nested quotations retain their own inset.

## Code stays literal

Inline handles such as `#project/2026-10-12-aurora` stay literal inside code. So do escaped references: \#action/2026-10-12-review.

```typescript
interface Launch {
  name: string;
  ready: boolean;
}

const launch: Launch = { name: 'Aurora', ready: true };
console.log(`${launch.name}: ${launch.ready ? 'ready' : 'review'}`);
// #artifact/2026-10-12-diagrams remains code, not a link.
```

```text
An intentionally long preformatted line: 0123456789 — sunrise / preparation / research / design / implementation / review / release / follow-up / a clear record for the next person.
```

## Tables work at different widths

| Decision | Evidence | Outcome |
| :--- | :--- | :--- |
| Make the next step visible | Five listening sessions | **Approved** |
| Keep a record of dropped ideas | Repeated project questions | ~~Confetti~~ |
| Preserve exact values | Engineers copy commands | `launch --quiet` |

The following table deliberately overflows a narrow reader. Each column remains readable as the table scrolls horizontally.

| Workstream | Mon 19 | Tue 20 | Wed 21 | Thu 22 | Fri 23 | Owner | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Research | Review notes | Tokyo handoff | Synthesize | Follow up | Archive | Jules | High |
| Design | Final words | Contrast | Motion | Export | Review | Mika | Medium |
| Release | Readiness | Rehearsal | Package | Publish | Learn | Rowan | High |

## References are part of the prose

Bare entity handles become readable references: #project/2026-10-12-aurora, #action/2026-10-12-review, and #entry/2026-10-18T09:30. Authored labels stay intact: [**Aurora's launch plan**](#project/2026-10-12-aurora) and [review the final decision](#action/2026-10-12-review).

Artifacts work the same way: #artifact/2026-10-12-diagrams, [the local media kit](#artifact/2026-10-12-media), and [the supporting Markdown specimen](#artifact/2026-10-12-typography/specimen.md). A [relative local document](../../assets/launch-checklist.md) opens in the file reader. An [external reference](https://example.com/aurora) retains its web destination.

Dates have their own references: #date/2026-10-19, #date/2026-10-19T14:00[America/Los_Angeles], and #date/2026-10-20T09:00[Asia/Tokyo].

Lifecycle treatments compose in the same line: backlog #action/2026-10-12-backlog; slipped #action/2026-10-12-slipped; due #action/2026-10-12-due; overdue #action/2026-10-12-overdue; done #action/2026-10-12-done; cancelled #action/2026-10-12-cancelled; ended project #project/2026-10-05-discovery.

## Language, punctuation, and long strings

“Thoughtful words” — a small pause, an en dash (10–12), an ellipsis… and a nonbreaking space in 10 AM. Café, naïve, façade, coöperate, Montréal, São Paulo. 東京の朝。清晰的文字。مرحبا بالعالم. Καλημέρα κόσμε. Emoji can share a line with text: 🌅 🧭 ✅.

A long unbroken token should wrap: aurora_release_candidate_2026_10_18_with_a_deliberately_long_unbroken_identifier_for_testing_narrow_readers_and_preventing_horizontal_page_overflow.

## Native semantic HTML

The renderer also retains safe HTML semantics: H<sub>2</sub>O, x<sup>2</sup>, <kbd>⌘</kbd> + <kbd>K</kbd>, <mark>a marked phrase</mark>, and an <abbr title="Application Programming Interface">API</abbr> abbreviation.

<details>
<summary>A native disclosure with more context</summary>
<p>This paragraph appears when the reader opens the disclosure. It demonstrates authored semantic HTML without injecting page styles.</p>
</details>

<dl>
<dt>Clarity</dt><dd>The next useful step is easy to see.</dd>
<dt>Continuity</dt><dd>Every decision has a trail back to its source.</dd>
</dl>

## An image belongs with its explanation

![Aurora's abstract sunrise over layered hills](#artifact/2026-10-12-media/aurora.svg)

The illustration is a local SVG attachment. Its alternative text explains the content when the image is unavailable.

---

Horizontal rules remain deliberately quiet in the shared document design. The content continues with the same vertical rhythm.
