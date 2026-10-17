# Accepted lattice changes

`places/lattice.mjs diff` and `verify.mjs --previous` fail when more than 0.5 % of a tier's answers change between the
previous release and the candidate without a line here. One line per accepted change, as a list item with a code span
`tier old-key new-key` (a key may be `*`) and the reason, grouped by the release that accepts it.

## 1.0.0

The first release: there is no previous release to compare with.
