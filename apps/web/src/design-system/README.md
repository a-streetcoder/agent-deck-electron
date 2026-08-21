# Agent Deck renderer design system

The design system is the single visual and interaction boundary for the Electron renderer. It is renderer-local because CSS variables, Tailwind, and React components work identically in Chromium on macOS, Windows, and Linux.

## Layers

1. **Tokens** — `tokens.css` owns reusable visual values and light/dark values.
2. **Utilities** — `tailwind.config.ts` maps semantic tokens and the standard layout scale.
3. **Components** — `components/` owns native controls and reusable interaction contracts.
4. **Domain adapters** — `themes/` translates tokens for CodeMirror, Shiki, and xterm.
5. **Feature views** — compose the layers above and retain only domain state and unique layout.

## Typography

Tokens in `tokens.css` are the only type ramp. Tailwind maps them as `text-micro` through `text-heading`, plus `text-code` / `text-code-sm`. Default Tailwind size keys still generate (`theme.extend.fontSize` does not remove `text-xs` / `text-sm` / `text-lg`, because the Sidebar wordmark needs `text-lg`). Feature code must not use those defaults; `pnpm check:design-system` lint-bans `text-xs` through `text-2xl` in `apps/web/src`.

| Token   | Size / leading | Role                                                          |
| ------- | -------------: | ------------------------------------------------------------- |
| micro   |        10 / 13 | Floor. Badges, keycaps, section headers.                      |
| detail  |        11 / 14 | Meta, chips, timestamps, small controls.                      |
| caption |        12 / 16 | Helpers, empty-state body, field descriptions.                |
| label   |        13 / 16 | Chrome: nav, list rows, control md/lg, field chrome.          |
| body    |        13 / 20 | Reading: chat, markdown, composer, dialogs.                   |
| title   |        15 / 20 | Page and in-page titles.                                      |
| heading |        20 / 26 | Hero / display (`SectionHero` and the onboarding tour title). |
| code    |        11 / 16 | Mono chrome (paths, keys).                                    |
| code-sm |        10 / 14 | Tiny mono IDs and gutters.                                    |

Tracking tokens: `tracking-overline` (0.08em) for group headers only; `tracking-ui` (−0.006em) on 12–13px chrome (`text-label`, body default, buttons, inputs, rows); `tracking-title` (−0.015em); `tracking-heading` (−0.02em). Use existing `font-normal` / `font-medium` / `font-semibold`. Do not use `font-bold` in chrome.

Apply roles as classes, not a Text/Heading primitive:

- Group / index header only: import `sectionHeaderClass` from `styles.ts`. Never retype the string. Never use this recipe on chips, status, tags, panel titles, or provider ids.
- Chips / status / tags: sentence-case `text-micro font-medium` or `text-detail font-medium`
- Chrome label / list row / nav: `text-label` (includes `tracking-ui`)
- Reading surfaces: `text-body` (no extra `leading-relaxed`)
- Page title: `text-title font-semibold tracking-title`
- Hero / onboarding tour title: `text-heading font-semibold tracking-heading`
- Field labels: `text-caption font-medium`
- Helper / empty body: `text-caption`
- Empty title: `text-label font-semibold`
- Meta: `text-detail`
- Badges / keycaps: `text-micro` (keycaps also `font-mono font-semibold`)
- Markdown: baseline `text-body`; h1 `text-title font-semibold tracking-title`; h2 `text-label font-semibold`; h3 `text-caption font-semibold`; h4–h6 `text-detail font-semibold`

Approved type exceptions:

- Sidebar pixel wordmark: `font-pixel text-lg leading-none` (only allowed default Tailwind size)
- Markdown inline code: `text-[0.85em]` (document-relative)
- `fontStretch: "expanded"` on `SectionHero` only (identity, not a token)
- CodeMirror / xterm keep their domain adapter font sizes

## Rules for new UI

- Use semantic Tailwind names such as `bg-surface-elevated`, `text-text-muted`, `border-danger`, and `text-detail`.
- Prefer `Button`, `IconButton`, and `TextField` when their supported contract fits.
- Specialized native controls must use `ControlButton`, `ControlInput`, `ControlTextArea`, or `ControlSelect`; do not render raw controls in feature files.
- Sheet/dialog chrome uses `SheetHeader` (bottom hairline) and `SheetFooter` (top hairline); the body has no trailing divider. Inner width and padding are `--size-sheet` / `--space-sheet`; page overlays clear traffic lights with `--size-titlebar` (`pt-titlebar`), not on the header primitive.
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

Run `pnpm check:design-system`. The check rejects undeclared CSS variables, app-owned raw colors, arbitrary visual token utilities, raw native controls outside the design system, and default Tailwind type sizes (`text-xs` through `text-2xl`). Keep exceptions exact and documented; do not allowlist directories broadly. The only type-size exception is the Sidebar pixel wordmark (`text-lg`). Markdown inline `text-[0.85em]` is already an arbitrary-visual exception.
