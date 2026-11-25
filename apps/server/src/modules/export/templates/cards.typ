// t-cli PDF export: 单词卡 — 6 cards per A4 page (prototype PdfP4). Solid
// lines are cut, the dashed line in the middle is folded backwards: the
// front (word, IPA) and the back (meaning, example) then read upright when
// the card is turned over left to right.

#import "common.typ": *

// 6 × 39 mm plus the legend fit the 249 mm text area of every page.
#let card-height = 39mm
#let per-page = 6

#let legend() = block(above: 0pt, below: 10pt, {
  set text(size: 9.75pt, fill: ink2)
  box(line(length: 9mm, stroke: rule + ink), baseline: -0.3em)
  h(0.4em)
  [实线剪开]
  h(1.6em)
  box(line(length: 9mm, stroke: dashed), baseline: -0.3em)
  h(0.4em)
  [虚线向后对折]
  h(1.6em)
  [正面单词，背面释义，左右翻面就能读]
})

// Content centred vertically in a fixed-height half card; overflow is clipped.
#let half(body, alignment) = block(
  width: 100%,
  height: card-height,
  inset: (x: 6mm),
  clip: true,
  align(alignment + horizon, body),
)

#let front(card) = half(
  stack(dir: ttb, spacing: 10pt * k, ..some(
    text(size: 22pt * k, weight: "semibold", card.term),
    if card.ipa != "" { text(size: 11.25pt * k, fill: ink2, card.ipa) },
  )),
  center,
)

#let back(card) = half(
  stack(dir: ttb, spacing: 9pt * k, ..some(
    text(size: 12.75pt * k, weight: "bold", card.gloss),
    if card.example != "" { text(size: 11.25pt * k, style: "italic", card.example) },
    if card.zh != "" { text(size: 9pt * k, fill: ink3, card.zh) },
  )),
  left,
)

#let card-sheet(cards) = grid(
  columns: (1fr, 1fr),
  rows: (card-height,) * cards.len(),
  stroke: (x, y) => (
    top: rule + ink,
    bottom: rule + ink,
    left: if x == 0 { rule + ink } else { dashed },
    right: if x == 1 { rule + ink } else { dashed },
  ),
  ..cards.map(card => (front(card), back(card))).flatten(),
)

#let cards-doc() = {
  if data.cards.len() == 0 {
    legend()
    empty-note()
  }
  for (index, chunk) in data.cards.chunks(per-page).enumerate() {
    if index > 0 { pagebreak() }
    legend()
    card-sheet(chunk)
  }
}
