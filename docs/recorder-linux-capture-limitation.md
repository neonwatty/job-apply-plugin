# Linux recorder capture evidence

## PR 48 failure

At commit `715828d`, CI run `33971038295` rejected the
`validation-observed` checkpoint in both the recorder shard and legacy lane.
The test had already recorded its post-navigation interaction. The prior
event synchronization repair therefore did not resolve this failure.

The same checkpoint failure reproduced repeatedly in a local Linux arm64
container using `mcr.microsoft.com/playwright:v1.62.1-noble`. This matches the
locked Playwright version, but is not an exact GitHub runner replica: the
container has Node 24 whereas CI uses Node 20 on Linux x64.

Temporary, restricted diagnostics identified the existing post-screenshot
layout check as the rejection source. CDP content width changed from 765 to
780 pixels while height stayed at 1643 pixels. The width was still 780 after
another script turn. This is consistent with a 15-pixel native scrollbar
disappearing during capture. Diagnostics were removed after investigation.

## Scoped fixture correction

The successful-capture scenario now reserves scrollbar space with
`scrollbar-gutter: stable` on its synthetic document. Its vertical overflow,
below-fold and nested scroll controls, hidden frames, privacy canaries,
disconnect ordering, and checkpoint assertions are unchanged.

No production capture code, timeout, retry policy, or layout tolerance was
changed. The exact layout-drift rejection and its unit tests remain in place.

## Unresolved production limitation

A real page whose native scrollbar changes its content geometry during
capture may still be rejected. The fixture correction does not establish
support for that page. Rejection is fail-closed; accepting a screenshot of a
different layout could invalidate the relationship between inspected content
and captured pixels.

A future production fix needs to prevent the geometry change or restore and
revalidate the exact page state. It must retain sensitivity, document identity,
layout, and resource checks. Adding a width tolerance, hiding arbitrary page
scrollbars, or retrying until a capture passes is not an established solution.
