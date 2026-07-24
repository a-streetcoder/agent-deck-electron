# Agent Deck renderer design system

The design system is the single visual and interaction boundary for the Electron renderer. It is renderer-local because CSS variables, Tailwind, and React components work identically in Chromium on macOS, Windows, and Linux.

## Layers

1. **Tokens** — `tokens.css` owns reusable visual values and light/dark values.
2. **Utilities** — `tailwind.config.ts` maps semantic tokens and the standard layout scale.
3. **Components** — `components/` owns native controls and reusable interaction contracts.
4. **Domain adapters** — `themes/` translates tokens for CodeMirror, Shiki, and xterm.
5. **Feature views** — compose the layers above and retain only domain state and unique layout.

## Rules for new UI

- Use semantic Tailwind names such as `bg-surface-elevated`, `text-text-muted`, `border-danger`, and `text-detail`.
- Prefer `Button`, `IconButton`, and `TextField` when their supported contract fits.
- Specialized native controls must use `ControlButton`, `ControlInput`, `ControlTextArea`, or `ControlSelect`; do not render raw controls in feature files.
- Flex/grid, responsive layout, percentages, viewport sizes, and runtime geometry may remain local.
- Reusable colors, typography, radii, shadows, layers, and motion belong in `tokens.css` and must be mapped through Tailwind.
- A repeated composition should become a component after it has at least two real consumers or when it owns shared accessibility behavior.
- Do not add wrappers merely to hide a single structural `className`.

## Theme behavior

`installSystemTheme` follows the operating-system appearance and emits a design-system theme event. React code uses `useResolvedTheme`; imperative integrations subscribe through their adapter. Every new token must have acceptable contrast in both themes.

## Approved exceptions

- `components/diff/EditorIcons.tsx` and `JetBrainsIcons.tsx` preserve vendor artwork colors.
- `components/browser/picker.ts` styles an isolated inspected web page and cannot inherit renderer CSS variables.
- Markdown inline code uses relative `em` sizing because it belongs to document typography.
- Dynamic splitter sizes, measured panel dimensions, progress geometry, and media dimensions remain component-owned inline values.
- Domain-colored avatars use `tintedSurfaceStyle` rather than recreating color-mix formulas.

## Checks

Run `pnpm check:design-system`. The check rejects undeclared CSS variables, app-owned raw colors, arbitrary visual token utilities, and raw native controls outside the design system. Keep exceptions exact and documented; do not allowlist directories broadly.
