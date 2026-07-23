# CLAUDE.md

## Git rules

- Do NOT add "Co-Authored-By: Claude" (or any co-author trailer) to commit messages.
- Never commit anything under `docs/` — it is gitignored on purpose; design specs and
  internal docs stay local. Do not `git add -f` files inside `docs/`.

## Project notes

- pnpm monorepo; run `pnpm typecheck` and `pnpm test` before committing.
- Product truth lives in `PRODUCT.md` (root, tracked). Inspector UI is a single
  self-contained HTML file (`apps/api/src/inspector.html`) — no build step, no
  external CDN requests, tokens for all colors.
