# TOOLS.md — Solone CEO

- Paperclip skill/API: assignments, checkout, comments, status, delegation, approvals.
- PARA memory skill: daily notes, durable facts, project entities, recall.
- Repository read-only checks: Git status/log/diff, current authority docs, test results.

## Safety Notes

- Domain work belongs in `solana-momentum-bot/`; Paperclip is coordination only.
- Do not use deploy/restart/live commands while `RETIRE_CURRENT_LIVE` is active.
- Do not inspect or copy secret env/key/token values. Use tracked examples/config and redacted status.
- A mutating Paperclip call needs the run-id/governance headers required by the Paperclip skill.
