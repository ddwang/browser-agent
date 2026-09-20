---
"@ddwang/magnitude-core": patch
---

Restore checkpoint instructions with observations and notes without changing receiving runtime settings. Apply the current agent's caching policy to supplied task memory, and replace saved instructions when current agent or call prompts are supplied. Preserve saved instructions when those prompts are omitted, without accumulating repeated prompt text.

Reset frozen retention and cache markers when instructions or caching policy changes, without deleting saved evidence. Preserve cached history when those values are unchanged.
