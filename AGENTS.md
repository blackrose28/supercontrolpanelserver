<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **cc-server** (1730 symbols, 6109 relationships, 147 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/cc-server/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Test-Driven Development (TDD) - MANDATORY

**All incremental changes MUST follow strict TDD practices. No exceptions.**

### TDD Workflow (Red-Green-Refactor)

1. **RED: Write the test first**
   - Write a failing test that describes the desired behavior
   - Run the test to confirm it fails for the right reason
   - Do NOT write any implementation code yet

2. **GREEN: Make it pass**
   - Write the minimal code needed to make the test pass
   - Run the test to confirm it passes
   - Do not add extra features or "nice-to-haves"

3. **REFACTOR: Clean up**
   - Improve code quality without changing behavior
   - Run tests to ensure they still pass
   - Update documentation if needed

### Mandatory Rules

- **NEVER write implementation code before writing the test**
- **NEVER skip writing tests** for any code change, no matter how small
- **NEVER commit code** without corresponding tests
- **ALWAYS run tests** before and after making changes
- **ALWAYS ensure** all existing tests still pass

### What Requires Tests

- New functions, methods, or components
- Bug fixes (write a test that reproduces the bug first)
- API endpoints and handlers
- State management logic
- UI interactions and user flows
- Edge cases and error handling
- Integration points between modules

### Test Coverage Requirements

- **Unit tests**: All business logic, utilities, and pure functions
- **Integration tests**: API endpoints, database operations, external service calls
- **Component tests**: React/UI components with user interactions
- **E2E tests**: Critical user flows (when applicable)

### Testing Stack

**Frontend (admin-next):**
- Framework: Vitest + React Testing Library
- Run: `npm test` or `npm test -- --run`
- Location: `*.test.tsx` or `*.test.ts` files

**Backend (NestJS):**
- Framework: Jest
- Run: `npm test` or `npm test -- --testPathPattern=<file>`
- Location: `*.spec.ts` files

**Rust (Tauri):**
- Framework: Built-in Rust testing
- Run: `cargo test`
- Location: `#[cfg(test)]` modules or `tests/` directory

### Example TDD Flow

```
# 1. RED - Write failing test
$ vim src/api/adminApi.test.ts
# Add test for requestRestartOpenvpn()
$ npm test
# ❌ Test fails - function doesn't exist

# 2. GREEN - Implement minimal code
$ vim src/api/adminApi.ts
# Add requestRestartOpenvpn() function
$ npm test
# ✅ Test passes

# 3. REFACTOR - Clean up if needed
$ vim src/api/adminApi.ts
# Extract common patterns, improve naming
$ npm test
# ✅ Tests still pass
```

### Enforcement

- Code reviews will reject PRs without tests
- CI/CD pipeline will fail if tests don't pass
- Agents must verify test coverage before completing tasks
- If you're tempted to skip tests, **STOP** and write them first

### Benefits of Strict TDD

- Catches bugs early in development
- Provides living documentation
- Enables confident refactoring
- Reduces debugging time
- Improves code design and modularity
- Makes code review easier

**Remember: Tests are not optional. They are part of the implementation.**

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/cc-server/context` | Codebase overview, check index freshness |
| `gitnexus://repo/cc-server/clusters` | All functional areas |
| `gitnexus://repo/cc-server/processes` | All execution flows |
| `gitnexus://repo/cc-server/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
