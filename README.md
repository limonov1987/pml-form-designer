# PML Form Designer

Визуальный дизайнер форм AVEVA E3D PML (`.pmlfrm`) для VS Code — по аналогии с дизайнером WinForms.
Visual form designer for AVEVA E3D PML forms (`.pmlfrm`) in VS Code — in the spirit of the WinForms designer.

[Русский](#русский) · [English](#english)

---

## Русский

### Идея

Форма собирается мышью (панель элементов → холст → свойства), а код `.pmlfrm` правится автоматически и **точечно**:
меняется только нужный фрагмент строки, ручной код, комментарии, отступы и регистр сохраняются.

Принципы:

- **файл — единственный источник правды**: никаких маркеров `#designer-begin/end` и скрытых файлов разметки;
  любую существующую форму можно открыть без подготовки;
- **парсер без потерь (CST)**: parse → print даёт исходный текст байт в байт;
- все правки идут через `WorkspaceEdit` — **Ctrl+Z / Ctrl+Y** общие с текстовым редактором;
- сохранение — **UTF-8 с BOM**; файлы в cp1251 открываются, перед первой правкой предлагается конвертация.

Связи с запущенным E3D нет: окончательная проверка — в E3D (`pml rehash`, `pml reload form !!имя`, `show !!имя`).

### Установка

```
npm install
npm run package          # → pml-form-designer-<версия>.vsix
code --install-extension pml-form-designer-<версия>.vsix
```

Открыть форму: правый клик по `.pmlfrm` → **Open With… → PML Form Designer** или команда **«PML: Открыть в дизайнере форм»**.
Язык интерфейса — русский или английский (настройка `pmlFormDesigner.language`, по умолчанию — язык VS Code).
Новая форма: **«PML: Новая форма»** (палитра команд, контекстное меню папки, кнопка «＋ Новая форма» в дизайнере).

### Что реализовано (0.1.1)

**Просмотр**
- холст с приблизительной раскладкой E3D: `path`/`hdist`/`vdist`/`align`, `at` (абсолютные и относительные `xmin .g`, `ymax .g + 1`, `xmax form`…),
  `width`/`height`/`lines`, frame, tabset (переключение вкладок), panel, foldup;
- дерево гаджетов и панель свойств (включая callback, назначенные в коде `!this.g.callback = |…|`, со ссылкой на метод);
- синхронное выделение: щелчок на холсте/в дереве → строка в коде, курсор в коде → гаджет на холсте;
  Alt+щелчок — следующий гаджет под курсором (наложенные гаджеты);
- гаджеты с неточной раскладкой (внутри `if`/`do`, макросы, сложные выражения) обведены пунктиром с пояснением,
  многострочные (`$`-перенос) — «только просмотр».

**Редактирование**
- панель элементов: button, frame, tabset, list, option, textpane, text, paragraph, toggle, combo, numericinput, slider,
  line, selector, container (PMLNet), rtoggle и «группа rtoggle» — перетаскиванием или «выбрать → щёлкнуть место»;
  порядок частей строки гаджета сверен с синтаксическими графами Справочника PML;
- перемещение мышью (сетка 0.5 × 0.25, направляющие к краям соседей, Alt — без привязки) и стрелками (Shift — ×4);
  изменение размера маркерами (для list/textpane — в строках, для pixmap — в пикселях);
- **абсолютная / относительная** запись на каждом гаджете с пересчётом без сдвига; привязка к соседу → `xmax .сосед + 1`;
  ссылки вперёд (на гаджет ниже по тексту) не создаются — ось пишется абсолютной;
- перемещение не сдвигает соседей, которые позиционировались от перемещаемого гаджета (как в WinForms);
- перенос гаджета (frame — с содержимым) в другой frame / на страницу tabset, с проверкой ссылок и запретами
  (frame в самого себя, гаджет внутри `if`/`do`…);
- свойства: имя (переименование всех ссылок по файлу), tag, X/Y текстом, ширина, высота/строки, callback, tooltip,
  anchor, dock, multiple, linklabel, текст paragraph;
- двойной щелчок — callback + заглушка метода (в методе инициализации или в строке гаджета — настройка);
  смена имени в поле Callback переименовывает метод и его вызовы, либо переключает на существующий;
- удаление (Del) с подтверждением, если на гаджет есть ссылки; «+» на вкладках — новая страница tabset.

**Новая форма с нуля** — мастер: имя → вид окна (dialog / docking right|left / resize / document) → заголовок →
шаблон («Пустая» или «Применить/Закрыть»). Шапка файла, конструктор, метод `.init()` через `!this.initCall`.

**Локализация (0.1.1)** — интерфейс на русском и английском: команды и настройки (по языку VS Code), панели, сообщения,
а также тексты по умолчанию в генерируемом коде (`|Кнопка|` / `|Button|`, `|Страница 1|` / `|Page 1|`, шапка и описания методов новой формы).

**Проверки качества**
- модульные тесты (`npm test`, 40 тестов);
- корпусные прогоны на ~1300 реальных формах (штатная AppWare E3D 2.1 + проектные формы):
  печать без потерь — 0 расхождений; ~88 000 правок и ~5 500 переносов без новых диагностик внешнего анализатора PML;
- сквозной тест webview в Edge через puppeteer-core (`npm run e2e`, 17 сценариев мышью/клавиатурой).

### Настройки

| Настройка | Значение |
|---|---|
| `pmlFormDesigner.callbackPlacement` | `init` — `!this.g.callback = \|…\|` в методе инициализации; `gadget` — в строке гаджета |
| `pmlFormDesigner.positionStyle` | `auto` (по файлу), `spaced` (`xmin .g + 0.25`), `compact` (`xmin.g+0.25`) |
| `pmlFormDesigner.developer` | автор в шапке новых форм (пусто — имя пользователя ОС) |
| `pmlFormDesigner.formNamePrefix` | префикс имён новых форм команды (подставляется и проверяется; пусто — без проверки) |
| `pmlFormDesigner.newFormFolder` | папка новых форм относительно рабочей папки, напр. `working/gcc` (пусто — выбор в диалоге) |
| `pmlFormDesigner.language` | `auto` (по языку VS Code), `en`, `ru`; после смены — переоткрыть дизайнер |

### Разработка

```
npm test                 # модульные тесты
npm run build            # tsc → out/
npm run preview -- <form.pmlfrm> <out.html> [строка]   # HTML-превью холста без VS Code
npm run e2e -- [папка]   # сквозной тест webview (нужен Microsoft Edge)
npm run corpus | layout | plugincheck | reparentcheck  # прогоны по корпусу форм (пути к библиотекам — в package.json)
```

Структура: `src/core/` — лексер, разбор строки гаджета (`gadget.ts`), дерево формы (`form.ts`), точечные правки (`edits.ts`),
операции дизайнера (`operations.ts`), раскладка (`layout.ts`), шаблон новой формы (`template.ts`), кодировки (`encoding.ts`);
`src/extension.ts` — CustomTextEditorProvider и команды; `media/` — webview (холст, панели).

### Ограничения

- раскладка **приблизительная**: единицы E3D (ширина символа, высота строки, VDIST) ещё не откалиброваны по скриншотам E3D;
- гаджеты с `$`-переносом, макросами в имени, внутри `if`/`do` в `setup form` — только просмотр;
- меню/bar, view, NetGrid-содержимое container на холсте не редактируются (строки сохраняются как есть);
- нет мультивыделения, выравнивания группы, копирования/вставки.

### Пути развития

1. **Калибровка по E3D** — подобрать единицы сетки, высоту строк и зазоры по эталонным скриншотам форм.
2. **Мультивыделение и выравнивание** — рамка выделения, выравнивание по краям/центру, одинаковый размер, распределение.
3. **Копирование/вставка гаджетов** (в т. ч. между формами) с уникальными именами и пересчётом ссылок.
4. **Шаблоны форм** команды — свои заготовки в настройках/папке шаблонов.
5. **Редактор меню и bar** (`menu`, `!this.m.add(...)`), контекстные меню гаджетов.
6. **Список свойств шире** — все опции гаджетов по графам Справочника (combo editable, slider range, numericinput format…), отображение `pixmap`.
7. **Буфер команд для E3D** — кнопка «скопировать `pml reload form !!x` / `show !!x`».
8. Опционально — **живой предпросмотр** через PMLNet-аддин в E3D.
9. Публикация в VS Code Marketplace / Open VSX.

---

## English

### Concept

Build a form with the mouse (toolbox → canvas → properties) while the `.pmlfrm` source is updated automatically and
**surgically**: only the affected fragment of a line changes; hand-written code, comments, indentation and keyword case are preserved.

Principles:

- **the file is the single source of truth** — no `#designer-begin/end` markers and no side files; any existing form opens as is;
- **lossless parser (CST)** — parse → print reproduces the original text byte for byte;
- every change is a `WorkspaceEdit`, so **Ctrl+Z / Ctrl+Y** are shared with the text editor;
- files are saved as **UTF-8 with BOM**; cp1251 files open fine and conversion is offered before the first edit.

There is no connection to a running E3D session: final verification is in E3D (`pml rehash`, `pml reload form !!name`, `show !!name`).

### Installation

```
npm install
npm run package          # → pml-form-designer-<version>.vsix
code --install-extension pml-form-designer-<version>.vsix
```

Open a form: right-click a `.pmlfrm` → **Open With… → PML Form Designer**, or run **"PML: Open in Form Designer"**.
New form: **"PML: New Form"** from the command palette, the folder context menu or the "＋" button in the designer.
The UI is available in English and Russian (setting `pmlFormDesigner.language`, defaults to the VS Code display language).

### Implemented (0.1.1)

**Viewing**
- canvas with an approximate E3D layout: `path`/`hdist`/`vdist`/`align`, `at` (absolute and relative `xmin .g`, `ymax .g + 1`, `xmax form`…),
  `width`/`height`/`lines`, frame, tabset (clickable tabs), panel, foldup;
- gadget tree and property panel (including callbacks assigned in code, `!this.g.callback = |…|`, with a link to the method);
- two-way selection sync between canvas/tree and code; Alt+click cycles through overlapping gadgets;
- gadgets with approximate layout (inside `if`/`do`, macros, complex expressions) are dashed with an explanation;
  multi-line (`$` continuation) gadgets are view-only.

**Editing**
- toolbox: button, frame, tabset, list, option, textpane, text, paragraph, toggle, combo, numericinput, slider,
  line, selector, container (PMLNet), rtoggle and an "rtoggle group" — drag & drop or pick-and-click;
  the order of gadget line parts follows the syntax graphs of the PML Reference Manual;
- move with the mouse (0.5 × 0.25 grid, snap lines to neighbour edges, Alt disables snapping) or arrow keys (Shift ×4);
  resize handles (rows for list/textpane, pixels for pixmap);
- per-gadget **absolute / relative** positioning toggle that keeps the gadget in place; snapping to a neighbour writes
  `xmax .neighbour + 1`; forward references (to gadgets later in the file) are never written — the axis becomes absolute;
- moving a gadget does not drag along neighbours positioned relative to it (WinForms-like behaviour);
- reparenting a gadget (a frame with its content) into another frame / tabset page, with reference checks and safeguards;
- properties: name (renames all references in the file), tag, X/Y as text, width, height/lines, callback, tooltip,
  anchor, dock, multiple, linklabel, paragraph text;
- double-click creates a callback and a method stub (in the init method or on the gadget line — configurable);
  editing the Callback field renames the method and its calls, or switches to an existing method;
- delete (Del) with confirmation when the gadget is referenced; "+" on tabs adds a tabset page.

**New form from scratch** — wizard: name → window kind (dialog / docking right|left / resize / document) → title →
template (empty or Apply/Close). File header, minimal constructor, `.init()` via `!this.initCall`.

**Localisation (0.1.1)** — English and Russian UI: commands and settings (follow the VS Code language), panels, messages,
and default texts in generated code (`|Button|` / `|Кнопка|`, `|Page 1|` / `|Страница 1|`, new form header and method descriptions).

**Quality checks**
- unit tests (`npm test`, 40 tests);
- corpus runs on ~1300 real forms (stock E3D 2.1 AppWare + project forms): lossless round-trip — 0 differences;
  ~88,000 edits and ~5,500 reparent operations with no new diagnostics from an external PML analyser;
- end-to-end webview test in Edge via puppeteer-core (`npm run e2e`, 17 mouse/keyboard scenarios).

### Settings

| Setting | Meaning |
|---|---|
| `pmlFormDesigner.callbackPlacement` | `init` — `!this.g.callback = \|…\|` in the init method; `gadget` — on the gadget line |
| `pmlFormDesigner.positionStyle` | `auto` (detect from file), `spaced` (`xmin .g + 0.25`), `compact` (`xmin.g+0.25`) |
| `pmlFormDesigner.developer` | author in the header of new forms (empty — OS user name) |
| `pmlFormDesigner.formNamePrefix` | team prefix for new form names (pre-filled and checked; empty — no check) |
| `pmlFormDesigner.newFormFolder` | folder for new forms relative to the workspace, e.g. `working/gcc` (empty — folder dialog) |
| `pmlFormDesigner.language` | `auto` (VS Code display language), `en`, `ru`; reopen the designer after changing |

### Development

```
npm test                 # unit tests
npm run build            # tsc → out/
npm run preview -- <form.pmlfrm> <out.html> [line]   # HTML canvas preview without VS Code
npm run e2e -- [folder]  # end-to-end webview test (requires Microsoft Edge)
npm run corpus | layout | plugincheck | reparentcheck  # corpus runs (library paths are set in package.json)
```

Layout: `src/core/` — lexer, gadget line parser (`gadget.ts`), form tree (`form.ts`), surgical edits (`edits.ts`),
designer operations (`operations.ts`), layout engine (`layout.ts`), new form template (`template.ts`), encodings (`encoding.ts`);
`src/extension.ts` — CustomTextEditorProvider and commands; `media/` — webview (canvas, panels).

### Limitations

- the layout is **approximate**: E3D units (character width, line height, VDIST) are not yet calibrated against E3D screenshots;
- gadgets with `$` continuation, macro names, or inside `if`/`do` within `setup form` are view-only;
- menus/bars, views and container (NetGrid) content are not editable on the canvas (their lines are kept verbatim);
- no multi-selection, group alignment or copy/paste yet.

### Roadmap

1. **Calibration against E3D** — grid units, line height and gaps from reference screenshots.
2. **Multi-selection and alignment** — rubber-band selection, align edges/centres, same size, distribute.
3. **Copy/paste of gadgets** (also between forms) with unique names and reference rewriting.
4. **Form templates** — team templates from settings or a templates folder.
5. **Menu and bar editor** (`menu`, `!this.m.add(...)`), gadget popup menus.
6. **Richer property grid** — all gadget options from the Reference Manual graphs (editable combo, slider range, numericinput format…), `pixmap` rendering.
7. **E3D command clipboard** — "copy `pml reload form !!x` / `show !!x`" button.
8. Optional **live preview** via a PMLNet add-in inside E3D.
9. Publishing to the VS Code Marketplace / Open VSX.

### License

MIT — see [LICENSE](LICENSE).
