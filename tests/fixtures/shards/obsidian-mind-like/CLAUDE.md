# Claude — vault agent

This file is the project-instructions surface that Claude reads when
operating inside this vault. The contract acceptance suite uses this
file to pin agent gating: when the user installs without selecting the
`claude` agent module, this file is absent from the install.

## Top-of-file region (used by conflict scenarios)

The contract suite's update fixtures change content in *this* region
between v6.0.0 and v6.1.0. A scenario that pre-edits this same region
in the user vault produces a real three-way merge conflict on update,
which is what scenario 11 (DiffView under `--yes`) needs.

## Bottom-of-file region (used by auto-merge scenarios)

User edits at the bottom of this file don't conflict with v6.1.0's
top-of-file change, so scenario 10 should auto-merge clean.
