# v0.1 Release Checklist

Use this before tagging or presenting the repository as a v0.1 release package.

## Repository

- [ ] Branch is canonical `main`.
- [ ] No branch named `Main` is used by branch protection, deploy settings, or release docs.
- [ ] GitHub repo is public and clean.
- [ ] No secrets are committed.
- [ ] `.env.example` is complete and uses placeholders.
- [ ] README status table is accurate.
- [ ] Limitations and custody sections are accurate.
- [ ] Demo video/GIF/Loom is recorded or explicitly left as a placeholder.

## Validation

- [ ] `corepack pnpm format` passes.
- [ ] `corepack pnpm lint` passes.
- [ ] `corepack pnpm typecheck` passes.
- [ ] `corepack pnpm test` passes.
- [ ] `corepack pnpm build` passes.
- [ ] `corepack pnpm smoke:dry` passes.
- [ ] `corepack pnpm validate:release` passes and writes `.release/validation.json`.
- [ ] `corepack pnpm release:check` passes.

## Live Smoke Evidence

- [ ] Commit SHA recorded.
- [ ] Date, operator, and environment recorded.
- [ ] AgentCash CLI health check completed.
- [ ] Live Telegram private-wallet test completed.
- [ ] Live Telegram group-wallet test completed.
- [ ] Live Telegram inline test completed, or marked not configured.
- [ ] Live Discord DM-wallet test completed.
- [ ] Live Discord guild-wallet test completed.
- [ ] Telegram webhook test completed, or marked not configured.
- [ ] Whether real funds were used is recorded.
- [ ] Any AgentCash CLI or upstream paid API failure is documented.

## Security And Custody

- [ ] README says this is not production custody.
- [ ] `CUSTODY_MODE=local_cli` is described as demo-only.
- [ ] No production custody claim is made.
- [ ] Runbooks are linked from README.
- [ ] Security caveats are not removed.
- [ ] Group/guild wallet limitations are visible.

## Release Notes

- [ ] Shipped behavior summarized.
- [ ] Experimental behavior labeled.
- [ ] Known unsafe production gaps listed.
- [ ] Next PR scope listed.
