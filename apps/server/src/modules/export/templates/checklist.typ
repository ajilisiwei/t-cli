// t-cli PDF export: 自测清单 — fold back along the dashed line between word
// and meaning, read the word, say the meaning, tick a box (three rounds).

#import "common.typ": *

#let checklist-doc() = {
  let c = data.checklist
  block(above: 4pt, below: 0pt, stack(
    dir: ttb,
    spacing: 11pt * k,
    block(text(size: 22pt * k, weight: "bold", c.heading)),
    text(size: 11.25pt * k, fill: ink2, c.subtitle),
  ))
  if c.rows.len() == 0 {
    empty-note()
  } else {
    block(above: 12pt * k, below: 10pt * k, text(size: 10.5pt * k, fill: ink2, c.intro))
    checklist-table(c.rows)
  }
}
