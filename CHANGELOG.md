# Changelog

## 0.1.1 — 2026-10-08

- English localisation / английская локализация:
  - commands and settings follow the VS Code display language (`package.nls.json`, `package.nls.ru.json`);
  - designer panels, status bar, tooltips and all messages in English or Russian;
  - default texts in generated code follow the language: `|Button|`, `|Page 1|`, `|Apply|` / `|Close|`, method descriptions of a new form;
  - new setting `pmlFormDesigner.language`: `auto` (VS Code language), `en`, `ru`.
- Unit test for the English mode (40 tests).

## 0.1.0 — 2026-10-08

- First public release: lossless `.pmlfrm` parser with surgical edits, canvas, toolbox (17 gadget types), properties,
  absolute/relative positioning, reparenting between frames, callbacks with method stubs, new form wizard.
