# Admin Next UI Refresh Checklist

## Goal
Upgrade `cc-server/admin-next` from utility-looking controls into a cohesive admin dashboard UI with clearer hierarchy, stronger action affordances, and more consistent empty/loading/error states.

## Working rules
- Follow strict TDD for every section refresh.
- Keep behavior stable unless the UX change is explicit and tested.
- Prefer lightweight CSS and small reusable patterns over new UI frameworks.
- Verify desktop and mobile behavior for every section touched.

## Shared design system pass
- [ ] Standardize section header layouts with title, helper copy, and top-right actions.
- [ ] Standardize button hierarchy: primary, secondary, quiet, destructive.
- [ ] Standardize badges/chips for state and status.
- [ ] Standardize empty, loading, retry, and error message patterns.
- [ ] Standardize panel spacing, card spacing, and responsive stacking rules.
- [ ] Standardize data-dense surfaces for tables, lists, logs, and cards.

## Section-by-section execution order

### 1) Device list
- [x] Upgrade refresh action styling and helper copy.
- [x] Add focused component test for upgraded refresh affordance.
- [ ] Revisit row-level action hierarchy and status styling.
- [ ] Improve table/card responsiveness and row scanning.

### 2) Runtime summary
- [x] Add focused component tests for improved header, helper text, and tunnel controls.
- [x] Replace raw text blocks with clearer summary cards or grouped lists.
- [x] Improve Boundary tunnel server actions and selected-log state.
- [x] Improve tunnel log viewer styling and log toolbar layout.
- [ ] Normalize retry and empty-state treatment.

### 3) Recent logs
- [x] Add focused component tests for controls and states.
- [x] Improve section header, helper copy, and refresh/limit controls layout.
- [x] Make log entries easier to scan by timestamp/type/source.
- [ ] Improve empty and loading treatments.

### 4) Command history
- [x] Add focused component tests for command actions and active selection styling.
- [x] Improve hierarchy between command list and audit details.
- [x] Refine filter/limit/refresh control layout.
- [ ] Improve badges for queued/executing/succeeded/failed states.

### 5) Transfer activity
- [x] Add focused component tests for action rows and states.
- [x] Clarify primary actions for stopping/resuming/dismissing transfers.
- [x] Improve transfer cards, progress emphasis, and metadata grouping.
- [x] Improve finished-transfer cleanup affordance.

### 6) Telemetry
- [x] Add focused component tests for filter layout and export affordance.
- [x] Improve filter grouping and readability.
- [x] Improve event row hierarchy and metadata density.
- [ ] Normalize export and empty-state treatment.

### 7) Device details
- [x] Add focused component tests for hierarchy and summary states.
- [x] Improve details presentation for key identity/runtime fields.
- [x] Reduce raw JSON/debug feel where possible.

### 8) Page-level polish
- [x] Improve tab bar visual hierarchy and active-state clarity.
- [x] Normalize spacing between sections and panels.
- [x] Review mobile layout consistency across expanded device tabs.
- [x] Remove remaining utility/test-looking controls.

## Verification checklist per batch
- [ ] Run the targeted component test file(s).
- [ ] Run related integration coverage in `src/App.test.tsx` and/or hook tests.
- [ ] Run `npm run lint:css`.
- [ ] Run `npm run typecheck` when unrelated repo issues are resolved or intentionally addressed.

## Progress log
- 2026-04-23: Device list refresh button upgraded with helper copy, pill styling, loading label, and focused component test.
- 2026-04-23: Runtime summary upgraded with helper copy, summary highlight cards, styled tunnel server controls, log toolbar polish, and focused component coverage.
- 2026-04-23: Recent logs upgraded with helper copy, a clearer limit toolbar, structured log cards, and focused component coverage.
- 2026-04-23: Command history upgraded with helper copy, a clearer toolbar, stronger command/audit hierarchy, and focused component coverage.
- 2026-04-23: Transfer activity upgraded with helper copy, a clearer toolbar, stronger transfer card hierarchy, and focused component coverage.
- 2026-04-23: Telemetry upgraded with helper copy, grouped filters/exports, clearer event rows, and focused component coverage.
- 2026-04-23: Device details upgraded with helper copy, grouped summary cards, and focused component coverage.
- 2026-04-23: Page-level device workspace polish added a clearer expanded-panel header and improved tab-shell hierarchy.
- 2026-04-23: Mobile viewport polish added horizontal tab scrolling, stacked panel spacing, tighter small-screen header padding, and focused regression coverage for the expanded device workspace.
- 2026-04-23: Follow-up mobile pass tightened stacked limit/filter controls across logs, commands, transfers, and telemetry so small-screen toolbars read cleanly without cramped inline fields.
