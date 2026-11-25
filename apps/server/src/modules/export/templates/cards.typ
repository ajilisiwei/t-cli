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

// A half card: `make(scale)` centred vertically, shrunk until it fits the
// fixed height (and width); whatever still does not fit is clipped.
#let half(make, alignment) = block(
  width: 100%,
  height: card-height,
  inset: (x: 6mm, y: 3mm),
  clip: true,
  align(alignment + horizon, shrink-to-fit(make)),
)

#let front(card) = half(
  scale => stack(dir: ttb, spacing: 10pt * k * scale, ..some(
    align(center, fit-term(card.term, size: 22pt * k * scale, weight: "semibold")),
    if card.ipa != "" { align(center, text(size: 11.25pt * k * scale, fill: ink2, card.ipa)) },
  )),
  center,
)

#let back(card) = half(
  scale => stack(dir: ttb, spacing: 9pt * k * scale, ..some(
    text(size: 12.75pt * k * scale, weight: "bold", card.gloss),
    if card.example != "" { text(size: 11.25pt * k * scale, style: "italic", card.example) },
    if card.zh != "" { text(size: 9pt * k * scale, fill: ink3, card.zh) },
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
