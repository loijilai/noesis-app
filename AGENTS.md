## Language

- Specs, tickets: Traditional Chinese prose, English domain terms.
- Code, comments, tests, commit messages: whatever the repo's documented coding standards say — `CODING_CONVENTION.md` or the like. Where none say, match the surrounding code; English when it is new.
- docs/agents/*: English, verbatim from the skill seeds — do not translate.
- Direct replies to the user — chat, Socratic questioning, review comments, any conversational output: Traditional Chinese, unless the user writes in a different language, in which case match them.

## Data

- This repo holds only the code. The cards and progress live in a separate data repo (the user's is private), found through `dataDir` in `noesis.config.json` or the working directory.
- Work on cards — writing, editing, adding images — is done from the data repo, which carries its own agent rules and skills. Do not copy card content into this repo: it is public.

## UI

- Frontend UI follows `DESIGN.md`.
