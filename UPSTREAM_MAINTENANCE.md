# Upstream maintenance policy

`@simonepri/refined-antigravity-acp` is an external upstream dependency, not vendored code.

## Rules

1. Pin the production dependency to an exact known-good version.
2. Keep upstream-specific imports behind `src/upstream/refined-antigravity.ts`.
3. Never import unpublished/internal package paths.
4. Let Dependabot propose updates rather than silently tracking `latest`.
5. Require CI before merging dependency updates.
6. Re-run the real headless probe on the target Antigravity host for meaningful upstream changes.
7. Once the HTTP server exists, add OpenAI protocol smoke tests to the same update gate.

## Normal update

```bash
git switch -c chore/update-refined-antigravity
pnpm upstream:update
pnpm check
pnpm probe:headless -- --permission-policy reject
pnpm probe:headless -- --permission-policy allow-once
git add package.json pnpm-lock.yaml
git commit -m "chore: update refined-antigravity-acp"
```

If the public API changes, adapt `src/upstream/refined-antigravity.ts` first. Avoid propagating upstream-specific changes into the rest of the server unless the semantic contract itself changed.
