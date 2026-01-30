# Copilot Instructions for the Codex Workspace

This workspace is a multi-repo workbench with reverse engineering, asset recovery, and tooling. Maintain high-fidelity changes, keep outputs auditable, and favor deterministic workflows. When unsure, ask once, then proceed with a safe default.

## Mission Standards (Always On)
- Be concise, deterministic, and reproducible.
- Prefer small, auditable changes over sweeping refactors.
- Never remove or rewrite data unless explicitly asked.
- Log assumptions when important and keep diffs minimal.
- Preserve user intent over personal preferences; ask only when critical.
- Prefer explicit, human-readable outputs over opaque binary artifacts.

## Research → Plan → Execute (Required)
When a task involves workflows, repos, or integration:
1. Research the existing workflow, scripts, and config files.
2. Plan a concise, high-fidelity approach and validate it against current repo state.
3. Execute in the smallest safe steps, checking for upstream changes first.

## Scope & Safety
- Do not access or modify secrets, tokens, or credentials not assigned to you by a user prompt during this session.
- Avoid destructive actions; never delete or overwrite source artifacts unless asked.
- Be a thorough note takes, all to be detailed - insightful - full of logic and underlying sources , notes in a form optimally useful to an AI coding agent.
- If a task could affect system stability, propose a reversible approach first.
- Keep access to networked resources explicit and minimal.

## Communication & Logging
- Use short, direct updates with outcomes and next steps.
- Summarize changes in terms of files and goals.
- Record any assumptions, constraints, or skipped steps.
- Prefer checklists for multi-step or long-running tasks.

## Git Workflow Guardrails
- Before any add/commit, check upstream and rebase/merge if needed.
- If upstream has new commits, pause and refactor against them before proceeding.
- Keep commit messages action-oriented and scoped.
- Prefer linear history when possible.

## Branching & Reviews
- Use a dedicated branch for multi-file or risky changes.
- Keep commits small and thematically grouped.
- When requested, include a short rationale and impact summary.

## Git LFS Policy
- Track explicit, specific LFS items by path rather than by broad file type.
- When in doubt, prefer path-specific tracking to avoid ballooning LFS usage.
- Validate that LFS patterns match only the intended files.

## Configuration Management
- Prefer config files over ad-hoc flags.
- Keep configs minimal and documented.
- Never embed raw tokens; use env var references.
- When changing defaults, document why and how to revert.

## AI Agent Asset Cataloging
When asked to catalog assets for AI use, include:
- Settings and configs (config.toml, settings.json, .env, tool config)
- Instructions and notes (README, docs, runbooks, plan docs)
- Source code (scripts, libraries, build files)
- CLI tooling and entrypoints
- Skills and prompts (agent instructions, skill registries, task templates)
- Hashes/metadata (checksums, inventories, summaries)
- Provenance logs and recovery directives

## Data Handling & Backups
- Keep catalog outputs machine-readable (TSV/CSV/JSON) and reproducible.
- Avoid moving large datasets unless asked; prefer lists for backup tooling.
- Record hashes when feasible for integrity verification.
- If storage is unstable, write outputs to a designated safe directory.

## Workspace Architecture (High-Level)
- Codex_Tools/: reusable tools and catalogs
- Codexs_Library/: reference docs, notes, recovery directives
- tools/: command-line utilities (UnityPy, Cpp2IL, ilspycmd)
- Unity Projects/: extracted Unity projects and testbed
- subject/: active targets (e.g., LegionLegacy_attempt3)

## Tooling & Automation
- Prefer existing scripts before adding new ones.
- Keep new tools single-purpose and documented.
- If a tool emits logs, store them with timestamped folders.
- Avoid hidden global state; favor explicit inputs/outputs.

## Key Workflows (Unity/Reverse Engineering)
1. Asset extraction via tools in tools/ and Codex_Tools/Tools/AssetExtraction
2. IL2CPP decompile/rebuild using Cpp2IL and the Assembly-CSharp-src tree
3. Android APK unpack/repack with apktool, then re-sign

## Testing & Verification
- If tests exist, run the narrowest relevant subset.
- For tooling changes, include a simple smoke run.
- Document any tests not run and why.

## Performance & Cost Awareness
- Prefer fast paths for large scans (prune heavy dirs, summarize, then deepen).
- Avoid repeated full traversals; cache inventories when possible.
- Keep logs concise to reduce I/O overhead.
- Batch file reads/edits when safe to reduce tool calls.
- Use targeted searches before broad scans; escalate only when needed.
- Avoid generating large binary artifacts; prefer lists, manifests, and checksums.
- Reuse prior results when unchanged to avoid redundant work.

## Legion Legacy (If Working There)
- Keep Il2CppDummyDll attributes intact in recovered C# files.
- Use script.json and dump.cs to map addresses/signatures when patching.
- Prefer existing Unity component naming for navigation and edits.
- Keep Unity project branding and settings consistent with Android build.

## Output Quality Checklist
- Did we check upstream commits before adding/committing?
- Are LFS patterns path-specific?
- Are changes minimal and reversible?
- Are outputs reproducible with clear steps?
- Are settings and instructions captured for backup?
- Are assumptions documented?
- Are sensitive files excluded from catalogs?
