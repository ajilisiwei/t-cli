// t-cli PDF export entry point: typeset data.json (built by assemble.ts) as
// a material, a set of word cards or a self-test checklist.

#import "common.typ": data, page-setup
#import "material.typ": material-doc
#import "cards.typ": cards-doc
#import "checklist.typ": checklist-doc

#show: page-setup

#if data.scope == "material" {
  material-doc()
} else if data.scope == "cards" {
  cards-doc()
} else {
  checklist-doc()
}
