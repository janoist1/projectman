# Visual style of the interface

Status: built (PM-363). Written so that every UI/UX member (Claude or Codex) continues the same look. Read it before
you design a screen; it replaces "keep one visual language" with something you can check against.

The product has **two styles** the user picks per account (Settings → Account → "Megjelenés"; saved on the account,
remembered in the browser):

| Id        | Name       | What it is                                          |
| --------- | ---------- | --------------------------------------------------- |
| `classic` | Klasszikus | Today's look and the default: warm, calm, rounded.  |
| `win311`  | Win 3.11   | The 1992 desktop: teal, silver, bevels, title bars. |

A style is a **token layer** plus a few global rules, never a second set of components. A component reads tokens
(`apps/web/src/styles/tokens.css`, `tones.css`); `styles/win311.css` overrides token values under
`:root[data-style='win311']`, and the dark values of that style are in its own `@media (prefers-color-scheme: dark)`
block placed after the light block (the attribute selector is more specific than tokens.css's dark block). Dark and
light follow the system; there is no switch. The attribute is set from `lib/uiStyle.ts` and, before the first paint,
by the inline script in `index.html`.

## Principles (both styles)

1. **One thing needs the owner, and it is the loudest thing.** "Needs you" ("rád vár") is the only signal colour on
   screen (Classic: orange; Win 3.11: yellow with black text). Nothing else may use it. A warning that is not "needs
   you" (a loaded machine, a nearly used plan, a stuck card, a failed delivery, a config problem) uses the **warning
   tokens** `--c-warn-*`: the same orange in Classic, a brown/amber in Win 3.11, never yellow. The machine-load
   indicator in the top bar is a warning, not a "needs you" surface.
2. **Colour never carries meaning alone.** Every state also has an icon or a word ("!", "?", a check, the label).
3. **Tokens, not values.** A colour, radius, shadow, font size or bevel in a component is a token. A new need becomes
   a new token with a neutral value in Classic, then the Win 3.11 value in `win311.css`.
4. **Hungarian text is text in `i18n/hu.ts`**; the style never changes wording.
5. **Both styles, light and dark, 1512 and 390 px.** A new or changed screen is photographed in all of them.
6. **Touch targets, contrast and focus do not depend on the style.** 44 px touch targets on a phone, text 4.5:1,
   a visible focus mark everywhere.

## Classic (Klasszikus)

- **Colour roles:** warm paper page (`--c-page`), white cards (`--c-surface`), near-black text (`--c-ink`),
  one dark primary (`--c-primary`), blue for "working" (`--c-accent`), orange for "needs you" (`--c-needs*`), green
  for done (`--c-ok*`), red for blocked (`--c-blocked*`). Column tints come from `--column-<tone>-fg/-bg`.
- **Type:** Bricolage Grotesque for headings and the board's big numbers (`--font-display`), Hanken Grotesk for
  text (`--font-body`), JetBrains Mono for keys and code (`--font-mono`).
- **Shape:** rounded (`--radius-*`), soft shadows (`--shadow-*`), thin hairlines (`--c-line*`).
- **Density:** roomy. Cards breathe; lists use one hairline between rows.
- **Icons:** the line icon set in `components/icons`, 1.5 px stroke, `currentColor`.
- **Motion:** short fades and slides (`pm-fade-in`), 120–200 ms ease; honours reduced motion.

## Win 3.11

Reference: Windows for Workgroups 3.11. Not a joke and not a skin: it is a serious, dense, legible desktop.

- **Colour roles** (from the old 16-colour palette; contrast in brackets):
  - desktop = teal `#008080` (`--c-page`); windows, buttons and the rail = silver `#c0c0c0`; lists and fields =
    white and sunken;
  - text black on silver (11:1); the selected colour and "primary" = navy `#000080` with white text (16:1);
  - "needs you" = yellow `#ffff00` with black text (19:1), always with a "!" or "?" beside it; **in light** the
    yellow is a background, never a text or icon colour: text and icons in a needs-you place use `--c-needs-mark`
    (black). A yellow dot or mark gets a black ring (`--mark-ring`) so it shows on white and on yellow;
  - warning (not "needs you") = brown on pale tan (`--c-warn-*`, 7:1); in dark, amber text on dark brown;
  - working = blue, done = green, blocked = dark red, each also with its icon or word.
  - Dark: charcoal silver (`#3c3c3c`), darker teal desktop (`#004040`), title bar navy `#1f2f7a`. In dark, a
    needs-you **surface** (a panel, a chip) is dark olive with yellow text and a yellow frame (so yellow _is_ a text
    colour in dark, on olive only); a **solid signal** (the count badge, the "Rád vár" pill) stays yellow with black
    text (`--c-needs`, `--c-on-needs`).
  - All text tokens (`--c-ink*`) are black in light, because some text sits straight on the teal desktop.
- **Type:** system fonts only (Tahoma, Verdana, Segoe UI, system-ui): nothing to download. Body text is 14 px
  (`--text-sm`, `--text-md`); **13 px (`--text-xs`) is the smallest reading text** (hints, meta lines) and 12 px
  (`--text-2xs`) is for non-reading marks only. On a phone the font is the system's own. Courier New for keys and
  code.
- **Shape:** **sharp corners everywhere**; `win311.css` forces `border-radius: 0 !important`, so a stray radius in a
  component does not break the look. Depth is done with **bevels**, not blur: raised (`--bevel-raised`: buttons,
  columns, popups) and sunken (`--bevel-sunken`: fields, pressed buttons, the selected rail item). Shadows
  (`--shadow-*`) are mapped to the bevels; a popup gets a hard 3 px offset shadow (`--shadow-pop`).
- **Windows:** a board column or a dialog is a window with a **title bar** (`--c-titlebar-*`). Inactive = white bar
  and black text; active (the window in focus, a dialog) = navy bar and white text
  (`--c-titlebar-active-*`). Title bar padding comes from `--titlebar-pad-y/-x`.
- **Density:** tighter than Classic, but touch targets keep 44 px on a phone.
- **Icons:** the same icon set, black, no tint.
- **Motion:** none. No transitions, no fades, no slides (`transition: none !important`, `--fade-from: 1`,
  `--fade-offset: 0`).

## States

| State                    | Both styles                                       | Win 3.11 detail                                    |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------- |
| Focus                    | visible on every control                          | 2 px dotted frame (`--focus-line`), offset 2 px    |
| Hover                    | one step lighter/darker (`--c-muted-hover`, etc.) | the same, no animation                             |
| Pressed                  | one step inward                                   | `--bevel-sunken`                                   |
| Selected                 | `--ring-selected` or the accent                   | navy ring/fill, white text; selection text is navy |
| Disabled                 | 50 % ink, no hover                                | the same; never only grey: keep the label          |
| Needs you                | the signal colour + "!"/"?"                       | yellow background, black text and mark             |
| Working / done / blocked | accent / ok / blocked tokens + icon or word       | blue / green / dark red + icon or word             |
| Loading, empty, error    | one sentence and, for an error, a retry button    | the same, plain                                    |

## Tone and what to avoid

- Plain, short, calm Hungarian. The product speaks to one tired person: say what needs them and what to do.
- **Avoid:** gradients, glow, glass blur and decorative illustrations in both styles; a second signal colour; text
  below 13 px in Win 3.11; round shapes or soft shadows in Win 3.11; mixing the styles on one screen; hard-coded
  hex values in components; pseudo-Windows kitsch (fake icons of old programs, "Program Manager" gags, sounds).
- Win 3.11 is mainly a **look**: the information order, the labels and the flows are the same as Classic. The
  accepted sample also has window forms (title bars on dialogs and panels, bevelled lists and tabs, a menu bar)
  that are **not all built yet**: today the columns, buttons, fields, dialogs and the picker have them. Treat the
  rest as the goal, follow the sample, and build a form with its tokens when you touch the screen. The remaining
  forms are tracked on their own card.

## Reference images

The review images of both styles are made by `scripts/scenarios/ui-styles.mjs` (`npm run shots --
scripts/scenarios/ui-styles.mjs`; Codex members use `take_screenshots`): the board, an open card with a question, the
"Rád vár" list, the Team page, a Settings page and the "Megjelenés" picker, light and dark, 1512 and 390 px, in
both styles. Add the screen you design to that scenario or make a scenario of your own with the same loop.

## Checklist for a designer's review

1. The screen is shot in Classic and Win 3.11, light and dark, at 1512 and 390 px.
2. Only tokens: no new hex, radius, shadow or font size in a component. A needed token is added in `tokens.css`
   (neutral in Classic) and given its Win 3.11 value in `win311.css`.
3. "Needs you" is the only signal colour and has a mark; other warnings use `--c-warn-*`; in light, yellow is never a
   text colour.
4. Contrast: text 4.5:1, large text and icons 3:1, in all four combinations (style × light/dark).
5. Win 3.11: sharp corners, bevels instead of shadows, no animation, 13 px minimum reading text, the dotted focus
   frame.
6. Focus is visible and the order is right; targets are 44 px on a phone; the text fits at 390 px.
7. Nothing is hardcoded in Hungarian: the text is in `i18n/hu.ts`.
