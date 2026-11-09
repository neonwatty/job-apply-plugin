# Local Next.js Companion first slice

Deliver a React/Next.js App Router frontend with strict TypeScript, Overview and Jobs creation/editing/filtering, guarded local HTTP transport, and a supervised standalone launcher. Keep the full existing workspace available at /legacy/ while remaining screens migrate. Preserve token/Host/Origin checks, revision conflicts, explicit draft reapply, raw API JSON, and human-only submission.

Python remains the sole Store writer. The TypeScript API adapter forwards a closed existing route inventory to its owned loopback Python service; it is not the native TypeScript Store implementation. No installed plugin update or hosted deployment is part of this slice.

The frozen local cell retains all six accepted legacy tests and adds security/inventory/launcher, editor-contract, and real production standalone browser coverage. Fixtures have separate temporary Stores and owned headless browsers. Verify normal size, typecheck, matrix, migration inventory and affected tests after integration. Hosted test observation windows do not gate this slice.

Next tranche: move API DTOs into shared domain contracts as the native TypeScript Jobs service is implemented against separate fixture Stores, then port remaining React screens. Live writer cutover requires the CLI/agent mutation paths to migrate together. Hosted auth/storage and Vercel deployment remain later work.


The serving change is active in the checkout when installed. Package activation uses the audit schema value inert; this does not mean application code is inactive. Python remains the sole live Store writer. This milestone does not claim backend cutover, hosted readiness or installed-plugin completion.
