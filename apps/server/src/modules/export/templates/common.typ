// t-cli PDF export: page setup, palette and shared pieces.
//
// SECURITY: every piece of user text arrives through data.json (read with
// json() below) and is placed as a string value, i.e. as plain text. Never
// pass data to eval(), read(), include, image() paths or any other function
// that interprets or loads its argument.

#let data = json("data.json")

// "large" (大字号) scales the reading text; header and footer stay put.
#let k = if data.options.large { 1.18 } else { 1.0 }

// Ink on white. Grey text is never lighter than #595959; indigo marks only
// section numbers and kickers, so a black-and-white print loses nothing.
#let ink = rgb("#1a1a1a")
#let ink2 = rgb("#3d3d3d")
#let ink3 = rgb("#595959")
#let rule-light = rgb("#bdbdbd")
#let rule-write = rgb("#8c8c8c")
#let accent = rgb("#2f3e7a")

#let hairline = 0.5pt
#let rule = 0.75pt
#let dashed = (paint: ink, thickness: rule, dash: "dashed")

#let serif = ("Source Serif 4", "Noto Serif SC")

// Drops the `none`s an `if` without `else` leaves behind.
#let some(..items) = items.pos().filter(item => item != none)

#let page-number = context [第 #counter(page).display() 页 / 共 #counter(page).final().first() 页]

#let scales = (1.0, 0.92, 0.84, 0.76, 0.68, 0.6, 0.55)

// `make(scale)` at the largest scale (100 % down to 55 %) whose wrapped
// height fits the space it is laid out in (a long meaning on a card).
#let shrink-to-fit(make) = layout(size => {
  let scale = scales.find(scale => measure(make(scale), width: size.width).height <= size.height + 0.1pt)
  make(if scale == none { scales.last() } else { scale })
})

// The largest scale at which the widest word of `term` fits `width`, or none.
#let term-scale(term, size, width, ..style) = {
  let widest(scale) = calc.max(0pt, ..term.split(" ").map(word => measure(text(size: size * scale, ..style, word)).width))
  scales.find(scale => widest(scale) <= width)
}

// A headword at that scale; hyphenated only when even 55 % is too wide.
#let term-text(term, size, scale, ..style) = if scale == none {
  text(size: size * scales.last(), lang: "en", hyphenate: true, ..style, term)
} else {
  text(size: size * scale, ..style, term)
}

// A headword made smaller until its widest word fits the space it is laid
// out in ("internationalization" in a narrow table column).
#let fit-term(term, size: 11pt, ..style) = layout(region => term-text(term, size, term-scale(term, size, region.width, ..style), ..style))

#let page-setup(body) = {
  set document(title: data.title, author: ())
  set page(
    paper: "a4",
    margin: (x: 19mm, top: 26mm, bottom: 22mm),
    header-ascent: 34%,
    footer-descent: 38%,
    header: {
      set text(size: 9pt, fill: ink2)
      grid(
        columns: (1fr, auto),
        column-gutter: 12pt,
        data.header.left, data.header.right,
      )
      v(5pt, weak: false)
      line(length: 100%, stroke: rule + ink)
    },
    footer: {
      set text(size: 9pt, fill: ink2)
      grid(
        columns: (1fr, auto),
        column-gutter: 12pt,
        data.footer, page-number,
      )
    },
  )
  set text(font: serif, size: 11.5pt * k, fill: ink, lang: "zh", region: "cn", hyphenate: false)
  set par(leading: 0.62em, spacing: 0.9em, justify: false)
  set enum(numbering: "1.", body-indent: 0.6em)
  body
}

// "一 重点词" — the number in indigo, an optional grey aside.
#let section-title(num, title, aside: "") = block(above: 22pt * k, below: 10pt * k, sticky: true, {
  set text(size: 15pt * k, weight: "bold")
  text(fill: accent, num)
  h(0.6em)
  title
  if aside != "" {
    h(0.6em)
    text(size: 9.75pt * k, weight: "regular", fill: ink2, aside)
  }
})

#let sub-title(body) = block(above: 18pt * k, below: 9pt * k, sticky: true, text(size: 12pt * k, weight: "bold", body))

// A note shown instead of an empty list.
#let empty-note() = if data.empty != "" {
  block(above: 16pt, text(size: 11.25pt * k, fill: ink2, data.empty))
}

// Three tick boxes for the self-test checklist.
#let tick-boxes = stack(dir: ltr, spacing: 2.4mm, ..range(3).map(_ => box(width: 4.2mm, height: 4.2mm, stroke: rule + ink)))

// The self-test checklist: tick boxes, word (and IPA), a dashed fold line, meaning.
#let checklist-table(rows) = grid(
  columns: (24mm, 58mm, 1fr),
  align: (left + horizon, left + horizon, left + horizon),
  inset: (x, y) => (
    left: if x == 2 { 5mm } else { 0pt },
    right: if x == 1 { 3mm } else { 0pt },
    y: if y == 0 { 4pt } else { 2.6mm * k },
  ),
  stroke: (x, y) => (bottom: if y == 0 { rule + ink } else { hairline + rule-light }),
  grid.header(
    text(size: 9pt * k, fill: ink2)[第 1 · 2 · 3 遍],
    text(size: 9pt * k, fill: ink2, if rows.any(row => row.ipa != "") { "单词 · 音标" } else { "单词" }),
    text(size: 9pt * k, fill: ink2)[释义],
  ),
  grid.vline(x: 2, stroke: dashed),
  ..rows
    .map(row => (
      tick-boxes,
      layout(region => {
        let size = 12.75pt * k
        term-text(row.term, size, term-scale(row.term, size, region.width, weight: "semibold"), weight: "semibold")
        if row.ipa != "" {
          h(0.5em)
          box(text(size: 9.75pt * k, fill: ink2, row.ipa))
        }
      }),
      text(size: 11.25pt * k, row.gloss),
    ))
    .flatten(),
)
