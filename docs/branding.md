# Job Apply branding

The selected design is “Rising J — left side lowered” (iteration 27), with the original Helvetica/Arial wordmark. Color: `#174c3c`. Both trimmed ends share a diagonal; the shorter left stem preserves the J reading.

- [Combination mark](../site/assets/job-apply-logo.svg): editable original SVG, including system-font wordmark.
- [Icon](../site/assets/job-apply-icon.svg): standalone vector for square placements.
- [Visual walkthrough](../site/logo-walkthrough.html): concepts, studio evidence, final refinements, downloads, and recording script.

The Codex plugin manifest uses the 32px and 512px icon PNGs. The Companion serves its byte-identical icon through Next.js `app/icon.svg`, which also supplies browser-icon metadata. Its header uses this vector beside the original font. The public site and README use the same brand assets. Claude Code’s manifest has no icon field added; its repository branding is visible in the README.

Keep `apps/companion/app/icon.svg` identical to `site/assets/job-apply-icon.svg` when updating the icon. Preserve the accepted path geometry, transparent background, and one-color fill. Use the icon alone at small sizes, never squeeze the full wordmark into a square. The wordmark is live system-font text, so exact typography can vary across machines.

## Provenance and reproduction

Created with [Logo Designer](https://github.com/neonwatty/logo-designer-skill) and an earlier round-trip through [Lineage Logo Studio](https://github.com/lineagehq/lineage-logo), using published studio version 0.1.1. The original three bold directions received manual wordmark spacing edits followed by reviewed amber-only agent proposals. The final geometry was subsequently refined directly in SVG; it was not produced by those studio proposals.

To reproduce exports, use the designer skill’s `scripts/export.sh` with the complete supporting `lib/` directory and an installed renderer:

```sh
bash /path/to/logo-designer/scripts/export.sh site/assets/job-apply-logo.svg /tmp/job-apply-exports site/assets/job-apply-icon.svg
```

The design run used Sharp 0.34.5, exporting transparent PNGs at 16, 32, 48, 192, 512, 1024 and 2048px. Copy the 32px and 512px icon exports into the corresponding `site/assets/job-apply-icon-*.png` files. Verify dimensions and alpha, compare the vector copies, build the Companion, and check the header and browser icon before shipping.
