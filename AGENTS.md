# AGENTS Workflow Guide

This file defines how coding agents must work in this repository.

## 1) Branching is required
- For every new feature or bug fix, create a new branch before making code changes.
- Branch naming:
  - `feature/<short-description>` for features
  - `fix/<short-description>` for bug fixes

> Why this exists: isolated branches keep review scope clear and reduce accidental cross-task regressions.

## 2) Prioritize readability and maintainability
- Prefer clear, readable, maintainable code over premature optimization.
- Use simple, explicit logic unless complexity is required.
- Keep naming consistent and intention-revealing.

> Why this exists: code is read and changed far more often than it is written.

## 3) Make only necessary changes
- Edit only the files and lines required for the task.
- Avoid unrelated refactors unless they are required to safely implement the change.
- Keep diffs focused and easy to review.

> Why this exists: smaller diffs are safer to test, review, and roll back.

## 4) Document the full implementation flow
- Capture the development flow through incremental commits.
- Each commit must include:
  - A clear commit message (title)
  - A descriptive commit body explaining what changed and why

> Why this exists: commit history should explain decisions, not just record file changes.

## 5) Commit incrementally (do not batch everything at the end)
- Commit as each logical step is completed.
- Do not wait until all work is finished to create one large commit.
- Typical sequence:
  1. Setup / scaffolding
  2. Core implementation
  3. Tests and fixes
  4. Documentation updates

> Why this exists: incremental commits make debugging and review faster.

## 6) Quality checks before each commit
- Run relevant checks/tests for the scope of change.
- Ensure code style and linting (if configured) are satisfied.
- Confirm no unrelated files are staged.

> Why this exists: each commit should be independently understandable and stable.
