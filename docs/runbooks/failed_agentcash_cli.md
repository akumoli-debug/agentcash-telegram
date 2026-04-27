# Failed AgentCash CLI

## Symptoms

- `/readyz` fails on custody/AgentCash health.
- Paid calls fail after quote approval.
- Startup aborts when `SKIP_AGENTCASH_HEALTHCHECK=false`.

## Immediate Mitigation

- Do not set `SKIP_AGENTCASH_HEALTHCHECK=true` in production.
- Pause paid call demos if CLI health is failing.
- Keep balance/deposit/history available if the process is otherwise healthy.

## Commands / Env Changes

```bash
AGENTCASH_COMMAND=npx
AGENTCASH_ARGS=agentcash@0.14.3
corepack pnpm smoke:agentcash
```

## Data To Preserve

- CLI stderr/stdout length metadata from errors.
- App logs around health failure.
- Version of the AgentCash CLI used.

## Recovery

- Pin or repair the CLI package. Never switch demos or release builds to an unpinned dist tag.
- Run `corepack pnpm smoke:dry` then a no-funds live smoke.
- Resume funded tests only after health passes.

## Postmortem Notes

- Decide whether CLI supply-chain pinning needs to be stricter.
- Record downtime and failed quote ids.
