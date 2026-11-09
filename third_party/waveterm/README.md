# Wave Terminal tiling reference

Source: https://github.com/wavetermdev/waveterm

Revision inspected: `9f1c9670d407be3b93cf090319a63ef30bf54d0e`.

Copyright 2025, Command Line Inc. Licensed under Apache-2.0; see `LICENSE`.
The upstream `NOTICE` contains: `Copyright 2025, Command Line Inc.`

RanzoBot's `src/components/terminal-layout.ts` adapts the nested row/column,
weighted sizing, side/outer-edge move and center-swap behavior from
`frontend/layout/lib/{layoutTree,layoutNode,utils}.ts`. It is an immutable,
terminal-only implementation with minimum-size geometry, not a vendored copy
of Wave's Jotai/React-DnD layout engine. `TerminalPage` uses the same flat,
stably keyed rendering approach as Wave's `TileLayout.tsx` to avoid remounting
terminals as the tree changes.

Wave's workspace persistence, cross-tab behavior, ephemeral blocks and
non-terminal block types are not included.
