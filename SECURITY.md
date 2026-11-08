# Security

Plenum runs AI coding CLIs on your computer with the permissions you give each project, so security problems
matter. Please report them privately.

## Reporting a vulnerability

Use **Report a vulnerability** on this repository's [Security tab](../../security/advisories/new). Don't open a
public issue. Include what an attacker could do, how to reproduce it, and the Plenum version (Settings → About).

You'll get a reply within a week. Once a fix is released, the advisory is published with credit to you unless you'd
rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Plenum updates itself from this repository's releases.

## What's in scope

- An agent escaping its project's permission level, its worktree, or the network and install switches.
- Anything that reaches the user's own branch, pushes, or creates a repository without an approval.
- Plenum reading, storing, logging or sending credentials, or Export logs leaking them.
- The local MCP server or the app's preview server being reachable from other machines, or acting without the
  checks the app applies.

Problems in the AI CLIs themselves (Claude Code, Codex and others) belong with their makers.
