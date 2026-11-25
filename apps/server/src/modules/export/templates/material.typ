// t-cli PDF export: 学习资料 (one material, or several as 合集), in the read
// or the practice layout. Structure and type follow the approved prototype
// (PdfP1–PdfP3): overview, 重点词, 情景短文, 练习, 易错提醒, 自测清单, and in
// the practice layout every answer after a cut line at the end.

#import "common.typ": *

// ---------------------------------------------------------------- head

#let material-head(s) = {
  block(above: 4pt, below: 0pt, stack(
    dir: ttb,
    spacing: 11pt * k,
    text(size: 9.75pt * k, fill: accent, tracking: 0.06em, s.kicker),
    block(text(size: 25pt * k, weight: "bold", s.title)),
    text(size: 11.25pt * k, fill: ink2, s.subtitle),
  ))
  if s.stats.len() > 0 {
    block(
      above: 16pt * k,
      below: 0pt,
      width: 100%,
      inset: (y: 8pt * k),
      stroke: (top: hairline + rule-light, bottom: hairline + rule-light),
      grid(
        columns: (1fr,) * calc.max(4, s.stats.len()),
        ..s.stats.map(stat => [
          #text(size: 18pt * k, weight: "semibold", str(stat.value))#h(0.35em)#text(size: 10.5pt * k, fill: ink2, stat.label)
        ]),
      ),
    )
  }
  if s.reasons.len() > 0 {
    block(above: 14pt * k, below: 0pt, width: 100%, inset: (left: 10pt, y: 2pt), stroke: (left: rule + ink), {
      text(size: 9.75pt * k, weight: "bold", fill: ink2)[为什么推荐给你]
      set text(size: 10.5pt * k, fill: ink2)
      list(marker: [·], spacing: 5pt * k, ..s.reasons.map(reason => [#reason]))
    })
  }
}

// --------------------------------------------------------------- words

#let word-table(b) = {
  let cols = (44mm, 36mm * k, 1fr)
  let gutter = 4.5mm
  section-title(b.num, b.title)
  block(sticky: true, above: 0pt, below: 0pt, width: 100%, inset: (y: 4pt), stroke: (bottom: rule + ink), {
    set text(size: 9pt * k, fill: ink2)
    grid(
      columns: cols,
      column-gutter: gutter,
      if b.rows.any(row => row.ipa != "") { "单词 · 音标" } else { "单词" }, [释义], [例句],
    )
  })
  for row in b.rows {
    block(
      breakable: false,
      above: 0pt,
      below: 0pt,
      width: 100%,
      inset: (y: 7pt * k),
      stroke: (bottom: hairline + rule-light),
      grid(
        columns: cols,
        column-gutter: gutter,
        stack(dir: ttb, spacing: 4pt * k, ..some(
          fit-term(row.term, size: 14.25pt * k, weight: "semibold"),
          if row.ipa != "" { text(size: 10.5pt * k, fill: ink2, row.ipa) },
          if row.note != "" { text(size: 9pt * k, fill: ink3, row.note) },
        )),
        text(size: 11.25pt * k, row.gloss),
        stack(dir: ttb, spacing: 5pt * k, ..some(
          text(size: 11.25pt * k, style: "italic", row.example),
          if row.exampleZh != "" { text(size: 9.75pt * k, fill: ink3, row.exampleZh) },
        )),
      ),
    )
  }
}

// --------------------------------------------------------------- story

#let story(b) = {
  section-title(b.num, b.title)
  if b.heading != "" {
    block(above: 0pt, below: 9pt * k, sticky: true, text(size: 16.5pt * k, weight: "semibold", b.heading))
  }
  block(above: 0pt, below: 0pt, {
    set text(size: 12.75pt * k)
    set par(leading: 0.85em, spacing: 1.5em)
    for runs in b.paragraphs {
      par(runs.map(run => if run.b { strong(run.t) } else { [#run.t] }).join())
    }
  })
  if b.zh != none {
    block(above: 10pt * k, below: 0pt, text(size: 10.5pt * k, fill: ink2)[#text(weight: "bold")[中文大意]#h(0.8em)#b.zh])
  }
  block(above: 9pt * k, below: 0pt, text(size: 9pt * k, fill: ink3, b.hint))
}

// ----------------------------------------------------------- exercises

// The blank of a cloze item, or (read layout) its answer, underlined.
#let blank(answer) = if answer == none {
  box(width: 30mm * k, height: 0.9em, baseline: 0.2em, stroke: (bottom: rule + ink))
} else {
  box(inset: (x: 2pt), outset: (bottom: 2.5pt), stroke: (bottom: rule + ink), strong(answer))
}

// Ruled writing lines.
#let writing-lines(n) = for _ in range(n) {
  block(above: 0pt, below: 0pt, width: 100%, height: 9.5mm * k, stroke: (bottom: hairline + rule-write))
}

#let cloze(g) = {
  sub-title(g.label)
  block(breakable: false, width: 100%, inset: (x: 12pt, y: 9pt), stroke: rule + ink, {
    set text(size: 12.75pt * k)
    set par(leading: 0.8em)
    g.bank.map(word => box(word)).join([#h(1.2em) ])
  })
  v(4pt * k)
  set text(size: 12.75pt * k)
  enum(
    spacing: 11pt * k,
    ..g.items.map(item => [#item.before#blank(item.answer)#item.after]),
  )
}

#let prompts(g, lines, english) = {
  sub-title(g.label)
  enum(
    spacing: 12pt * k,
    ..g.items.map(item => block(breakable: false, width: 100%, {
      text(size: if english { 12.75pt * k } else { 12pt * k }, item.prompt)
      if item.answer == none {
        writing-lines(lines)
      } else {
        block(above: 6pt * k, below: 0pt, text(size: 12pt * k, weight: "semibold", item.answer))
      }
    })),
  )
}

#let exercises(b) = {
  section-title(b.num, b.title)
  for g in b.groups {
    if g.kind == "cloze" { cloze(g) } else if g.kind == "translate" { prompts(g, 2, false) } else { prompts(g, 1, true) }
  }
}

// ------------------------------------------------------------ mistakes

#let pair-grid(pairs) = grid(
  columns: (1fr, 1fr),
  column-gutter: 12pt,
  row-gutter: 12pt,
  inset: (x: 11pt, y: 9pt * k),
  stroke: hairline + rule-light,
  ..pairs.map(pair => stack(dir: ttb, spacing: 6pt * k, ..some(
    if pair.title != "" { text(size: 9pt * k, fill: ink3, pair.title) },
    text(size: 12pt * k, fill: ink2, strike(pair.wrong)),
    text(size: 12pt * k, weight: "semibold", pair.right),
    if pair.note != "" { text(size: 9.75pt * k, fill: ink2, pair.note) },
  ))),
)

#let mistakes(b) = {
  section-title(b.num, b.title, aside: b.aside)
  if b.pairs.len() > 0 { pair-grid(b.pairs) }
  if b.recaps.len() > 0 {
    block(above: 14pt * k, below: 2pt, sticky: true, text(size: 10.5pt * k, weight: "bold", b.recapTitle))
    for recap in b.recaps {
      block(
        breakable: false,
        above: 0pt,
        below: 0pt,
        width: 100%,
        inset: (y: 6pt * k),
        stroke: (bottom: hairline + rule-light),
        grid(
          columns: (44mm, 1fr),
          column-gutter: 4.5mm,
          text(size: 12pt * k, weight: "semibold", recap.term),
          stack(dir: ttb, spacing: 5pt * k, ..some(
            if recap.note != "" { text(size: 10.5pt * k, recap.note) },
            if recap.example != "" { text(size: 10.5pt * k, style: "italic", fill: ink2, recap.example) },
          )),
        ),
      )
    }
  }
}

#let grammar(b) = {
  section-title(b.num, b.title)
  block(above: 0pt, below: 10pt * k, text(size: 11.25pt * k, b.rule))
  if b.pairs.len() > 0 { pair-grid(b.pairs) }
}

#let checklist(b) = {
  section-title(b.num, b.title)
  block(above: 0pt, below: 8pt * k, text(size: 10.5pt * k, fill: ink2, b.intro))
  checklist-table(b.rows)
}

// ------------------------------------------------------------- answers

#let scissors = image(
  bytes(
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='#1a1a1a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><circle cx='6' cy='6' r='3'/><circle cx='6' cy='18' r='3'/><path d='M8.6 7.6L20 18'/><path d='M8.6 16.4L20 6'/></svg>",
  ),
  format: "svg",
  width: 4.8mm,
)

#let answers(groups) = {
  block(above: 24pt * k, below: 12pt * k, sticky: true, grid(
    columns: (auto, 1fr, auto),
    column-gutter: 6pt,
    align: horizon,
    scissors, line(length: 100%, stroke: dashed), text(size: 9pt, fill: ink2)[可沿此线剪下，下面是答案],
  ))
  block(above: 0pt, below: 8pt * k, sticky: true, text(size: 12pt * k, weight: "bold")[答案])
  set text(size: 10.5pt * k)
  set par(leading: 0.75em)
  for group in groups {
    if group.heading != none {
      block(above: 12pt * k, below: 6pt * k, sticky: true, text(weight: "bold", fill: ink2, group.heading))
    }
    // Each label in its own column, so a wrapped answer hangs under its text.
    for entry in group.lines {
      block(above: 7pt * k, below: 0pt, grid(
        columns: (auto, 1fr),
        column-gutter: 0.7em,
        text(weight: "bold", entry.label), [#entry.text],
      ))
    }
  }
}

// ---------------------------------------------------------------- body

#let material-doc() = {
  for (index, s) in data.sections.enumerate() {
    if index > 0 { pagebreak(weak: true) }
    material-head(s)
    for b in s.blocks {
      if b.kind == "words" { word-table(b) }
      else if b.kind == "story" { story(b) }
      else if b.kind == "exercises" { exercises(b) }
      else if b.kind == "mistakes" { mistakes(b) }
      else if b.kind == "grammar" { grammar(b) }
      else if b.kind == "checklist" { checklist(b) }
    }
  }
  if data.answers.len() > 0 { answers(data.answers) }
}
