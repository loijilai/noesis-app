# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues, reached through the `gh` CLI. Run inside the clone and `gh` infers the repo from `git remote`.

## Layout

There are no directories. A feature is a label, and every issue in it carries that label:

- `feature:<feature-slug>` — on the spec and on every ticket of that feature.
- `spec` — on the spec only.

Labels are created on first use, not up front:

```bash
gh label create "feature:<feature-slug>" --description "<feature-slug>" 2>/dev/null || true
gh label create spec --description "A feature spec" 2>/dev/null || true
```

The issue number is the identity of a spec or a ticket. Titles carry no numbering of their own — a spec is titled `Spec: <feature-slug>`, a ticket is titled with its own title and nothing else.

## Operations

The skills name these operations; this file is what they mean here.

- **Publish a spec** — `gh issue create --title "Spec: <feature-slug>" --label "feature:<feature-slug>" --label spec --body-file <file>`. Write the body to a file first; a heredoc through `--body` mangles long markdown.
- **Publish a ticket** — `gh issue create --title "<ticket title>" --label "feature:<feature-slug>" --body-file <file>`. Publish in dependency order, so every issue a ticket references already exists. Two lines in the body on top of what the skill's template says:
  - `Part of #<spec issue>` — omit it when the feature has no spec.
  - `Blocked by: #<n>, #<n>` — the blocking tickets as issue references, or "None — can start immediately". GitHub renders both as live links and backlinks, so the spec issue grows a list of its tickets on its own.
- **Fetch a spec or a ticket** — `gh issue view <number> --comments`. The user may pass a bare number, a `#number`, or the issue URL; all three give the number. When they name it in prose instead ("the health check ticket"), find it with `gh issue list --label "feature:<feature-slug>" --state all --json number,title` and confirm which one before reading it.

## Scope of this file

This file governs where issues live and how to operate on them. What goes *inside* a spec or a ticket belongs to the skills that write them.

**No skill closes an issue or ticks a checkbox.** Open and closed are yours: close an issue when you are satisfied the work is done, in the UI or with `gh issue close`. The skills only ever create issues and read them.

## Using a different tracker

Replace the contents of this file with the conventions of whatever you use — GitLab through `glab`, Jira, or prose describing your workflow. The skills only ever name the operations above; this file is the translation layer, and it is the only place that changes.
