// PML Form Designer: webview. Этап 3 — редактирование.
// Холст только рисует и собирает намерения пользователя; любые изменения уходят в расширение
// сообщением { type: 'op', req } (core/operations.ts) и возвращаются новым 'render' после правки текста.
(function () {
  const vscode = acquireVsCodeApi();

  // ---------- Язык: <html lang> задаёт расширение (ru | en); разметка по умолчанию — на русском ----------
  const EN = document.documentElement.lang === 'en';
  const T = (ru, en) => (EN ? en : ru);
  const STATIC_EN = {
    newForm: '＋ New form', newFormTip: 'Create a new form in the folder of this file',
    modeTip: 'How to write the position of new gadgets and gadgets without AT when moving',
    rel: 'Rel.', abs: 'Abs.', zoom: 'Zoom', grid: 'grid',
    tbBasic: 'Basic', tbContainers: 'Containers', tbMore: 'More',
    tipButton: 'button .x |Button| at … wid 10', tipText: 'text .x |Text| at … wid 10 is STRING', tipPara: 'para .x at … text |Label|',
    tipToggle: 'toggle .x |Check| at …', tipOption: 'option .x |Option| at … wid 10', tipCombo: 'combo .x |List| tagwid 8 at … wid 10',
    tipList: 'list .x |List| at … wid 20 hei 5', tipTextpane: 'textpane .x |Text| at … wid 30 hei 5',
    tipFrame: 'frame .x |Frame| at … wid 20 hei 4 / exit', tipTabset: 'frame .x tabset + page',
    toolRadiogroup: '◉ rtoggle group', tipRadiogroup: 'frame with two rtoggles (radio group, PML Reference 12.1)',
    tipContainer: "container .x PmlNetControl '' — for NetGrid / .NET", tipRtoggle: 'rtoggle .x |Choice| — only inside a frame',
    tipNumeric: 'numericinput .x |Number| tagwid 8 at … range 0 100 ndp 0 wid 6',
    tipSelector: 'selector .x |Elements| at … single wid 25 hei 8 database auto',
    tbHint: 'Drag onto the form, or pick and click a spot', selectHint: 'Select a gadget on the canvas or in the tree',
  };
  if (EN) {
    document.querySelectorAll('[data-i18n]').forEach(el => { const v = STATIC_EN[el.dataset.i18n]; if (v) el.textContent = v; });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { const v = STATIC_EN[el.dataset.i18nTitle]; if (v) el.title = v; });
  }

  const saved = vscode.getState() || {};
  const state = {
    data: null,
    selLine: saved.selLine ?? null,
    zoom: saved.zoom ?? 100,
    grid: saved.grid ?? true,
    activePage: saved.activePage ?? {},    // имя tabset → индекс страницы
    newMode: saved.newMode ?? 'rel',       // запись позиции новых гаджетов и гаджетов без AT
    pendingName: null,                     // выделить гаджет с этим именем после следующего render
    armedTool: null,                       // выбранный в панели элемент для вставки щелчком
    drag: null,
  };
  const persist = () => vscode.setState({ selLine: state.selLine, zoom: state.zoom, grid: state.grid, activePage: state.activePage, newMode: state.newMode });

  // Масштаб: единица сетки по X — условная ширина символа, по Y — высота строки
  const UX = 7.5, UY = 22;
  const kx = () => UX * state.zoom / 100, ky = () => UY * state.zoom / 100;
  const sx = v => Math.round(v * kx());
  const sy = v => Math.round(v * ky());
  // шаг сетки при перетаскивании (единицы)
  const STEP_X = 0.5, STEP_Y = 0.25;
  const snapX = v => Math.round(v / STEP_X) * STEP_X;
  const snapY = v => Math.round(v / STEP_Y) * STEP_Y;
  const r2 = v => Math.round(v * 100) / 100;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  // для сквозных тестов: дождаться перерисовки после правки
  window.__pmlDesigner = { get pending() { return !!state.pending; } };
  // pending: правка отправлена, новая раскладка ещё не пришла — новые операции по устаревшим координатам не начинаем
  const op = req => { state.pending = true; vscode.postMessage({ type: 'op', req }); };

  // ---------- Сообщения от расширения ----------
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'render') {
      state.pending = false;
      state.data = m;
      if (state.pendingName) {
        const g = m.layout.gadgets.find(x => x.name.toLowerCase() === state.pendingName.toLowerCase());
        if (g) { state.selLine = g.line; openPagesFor(g); }
        state.pendingName = null;
      } else if (state.selLine !== null && !m.props[state.selLine]) {
        state.selLine = null;   // строка выделенного гаджета исчезла (удаление/сдвиг строк)
      }
      renderAll();
    }
    if (m.type === 'cursor') selectByCursor(m.line);
    if (m.type === 'selectName') state.pendingName = m.name;
  });

  // ---------- Панель инструментов ----------
  $('zoom').value = state.zoom;
  $('showGrid').checked = state.grid;
  $('zoom').addEventListener('input', e => { state.zoom = +e.target.value; persist(); renderCanvas(); });
  $('showGrid').addEventListener('change', e => { state.grid = e.target.checked; persist(); renderCanvas(); });
  const renderMode = () => {
    $('modeRel').classList.toggle('on', state.newMode === 'rel');
    $('modeAbs').classList.toggle('on', state.newMode === 'abs');
  };
  $('newForm').onclick = () => vscode.postMessage({ type: 'newForm' });
  $('modeRel').onclick = () => { state.newMode = 'rel'; persist(); renderMode(); };
  $('modeAbs').onclick = () => { state.newMode = 'abs'; persist(); renderMode(); };
  renderMode();

  function renderAll() {
    renderBanners();
    renderTree();
    renderCanvas();
    renderProps();
  }

  // ---------- Плашки ----------
  function renderBanners() {
    const { model, encoding } = state.data;
    let b = '';
    if (encoding === 'cp1251') b += T('<div class="banner">Файл в кодировке cp1251 — правка в дизайнере после конвертации в UTF-8 с BOM.<button id="conv">Конвертировать в UTF-8 BOM</button></div>',
      '<div class="banner">The file is in cp1251 — editing in the designer is available after conversion to UTF-8 with BOM.<button id="conv">Convert to UTF-8 BOM</button></div>');
    for (const p of model.problems) b += `<div class="banner err">${T('Строка', 'Line')} ${p.line + 1}: ${esc(p.message)}</div>`;
    for (const w of model.warnings) b += `<div class="banner">${T('Строка', 'Line')} ${w.line + 1}: ${esc(w.message)}</div>`;
    if (model.setupLine === undefined) b += `<div class="banner err">${T('В файле не найден setup form.', 'No setup form found in the file.')}</div>`;
    $('banners').innerHTML = b;
    const conv = $('conv');
    if (conv) conv.onclick = () => vscode.postMessage({ type: 'convertEncoding' });
    $('title').textContent = model.formName ? `!!${model.formName}  ${model.formAttrs.join(' ')}` : 'PML Form Designer';
  }

  // ---------- Дерево ----------
  function renderTree() {
    const html = list => !list || !list.length ? '' : '<ul>' + list.map(n =>
      `<li><div class="row kind-${n.kind}${n.line === state.selLine ? ' sel' : ''}" data-line="${n.line}" title="${esc(n.label)}  (${T('строка', 'line')} ${n.line + 1})">` +
      esc(n.label) + (n.detail ? `<span class="detail">${esc(n.detail)}</span>` : '') +
      (n.readOnly ? `<span class="ro" title="${esc(n.readOnly)}">⚠</span>` : '') +
      '</div>' + html(n.children) + '</li>').join('') + '</ul>';
    $('tree').innerHTML = html(state.data.model.nodes);
  }
  $('tree').addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (state.data.props[+row.dataset.line]) select(+row.dataset.line, true);
    else vscode.postMessage({ type: 'reveal', line: +row.dataset.line });
  });

  // ---------- Холст ----------
  const byName = () => new Map(state.data.layout.gadgets.filter(g => g.name).map(g => [g.name.toLowerCase(), g]));
  const parentOf = (g, map) => g.parent ? map.get(g.parent.toLowerCase()) : null;

  function isHidden(g, map) {
    for (let cur = g; cur; cur = parentOf(cur, map)) {
      if (cur.page && (state.activePage[cur.page.tabset] ?? 0) !== cur.page.index) return true;
    }
    return false;
  }
  function depth(g, map) { let d = 0; for (let cur = parentOf(g, map); cur; cur = parentOf(cur, map)) d++; return d; }

  function renderCanvas() {
    if (!state.data) return;
    const { layout, model } = state.data;
    const map = byName();
    let body = '';
    for (const g of layout.gadgets) {
      const b = g.box;
      const cls = ['g', 'g-' + g.type];
      if (g.approx) cls.push('approx');
      if (g.readOnly) cls.push('readonly');
      if (g.line === state.selLine) cls.push('sel');
      if (isHidden(g, map)) cls.push('hidden-page');
      let inner = '';
      const tag = esc(g.tag ?? '');
      switch (g.type) {
        case 'button':
          if (g.flags.includes('linklabel')) cls.push('link');
          if (g.pixmap && !g.tag) { cls.push('pix'); inner = '🖼'; } else inner = tag;
          break;
        case 'toggle': case 'rtoggle': inner = `<span class="box"></span><span>${tag}</span>`; break;
        case 'text': case 'option': case 'combo': case 'numericinput':
          inner = (g.tagW ? `<span class="tagl" style="width:${sx(g.tagW)}px">${tag}</span>` : '') + '<span class="field"></span>'; break;
        case 'list': case 'selector': case 'textpane': {
          const rows = g.type === 'list' ? Array.from({ length: Math.min(g.lines ?? 5, 30) }, () => '<div class="rowx"></div>').join('') : '';
          inner = (tag.trim() ? `<span class="tagl">${tag}</span>` : '') + `<span class="field">${rows}</span>`; break;
        }
        case 'paragraph': if (g.pixmap) { cls.push('pix'); inner = '🖼'; } else inner = tag; break;
        case 'line': if (g.flags.includes('vertical')) cls.push('vert'); break;
        case 'container': inner = '.NET'; break;
        case 'view': case 'alpha': inner = g.type.toUpperCase(); break;
        case 'frame': {
          const sub = g.sub || 'normal';
          cls.push(sub);
          if (sub === 'tabset') {
            const pages = layout.gadgets.filter(p => p.page && p.page.tabset === g.name).sort((a, c) => a.page.index - c.page.index);
            const act = state.activePage[g.name] ?? 0;
            inner = '<div class="tabs">' + pages.map(p => `<span class="tab${p.page.index === act ? ' active' : ''}${p.line === state.selLine ? ' tsel' : ''}" data-tabset="${esc(g.name)}" data-page="${p.page.index}" data-line="${p.line}">${esc(p.tag || p.name)}</span>`).join('') +
              (g.readOnly ? '' : `<span class="tab add" data-addpage="${g.line}" title="${T('Добавить страницу', 'Add page')}">+</span>`) + '</div>' +
              `<div class="tabbody" style="top:${sy(g.content.dy) - 1}px"></div>`;
          } else if (!g.page && (sub === 'normal' || sub === 'folduppanel')) {
            inner = tag.trim() ? `<span class="ftitle">${tag}</span>` : '';
          }
          if (g.page) cls.push('page');
          break;
        }
        default: inner = tag;
      }
      if (g.readOnly) inner += `<span class="ro-badge" title="${T('Правка только в коде', 'Edit in code only')}">⚠</span>`;
      if (g.line === state.selLine && !g.readOnly && !g.page) inner += '<span class="h h-e" data-h="e"></span><span class="h h-s" data-h="s"></span><span class="h h-se" data-h="se"></span>';
      const z = (g.type === 'frame' ? 0 : 100) + depth(g, map);
      const tip = `${g.type} .${g.name}` + (g.approx ? ` — ${T('приблизительно', 'approximate')}: ${g.approxWhy || ''}` : '') + (g.readOnly ? T(' — правка только в коде', ' — edit in code only') : '');
      body += `<div class="${cls.join(' ')}" data-line="${g.line}" title="${esc(tip)}" ` +
        `style="left:${sx(b.x)}px;top:${sy(b.y)}px;width:${Math.max(sx(b.w), 2)}px;height:${Math.max(sy(b.h), 2)}px;z-index:${z}">${inner}</div>`;
    }
    const W = sx(layout.width) + sx(10), H = sy(layout.height) + sy(4);   // запас для перетаскивания за край
    const gridStyle = state.grid ? `background-size:${sx(1)}px ${sy(1)}px;` : '';
    $('canvas').innerHTML =
      `<div class="form-window" style="width:${W}px">` +
      `<div class="form-title">${esc(model.formName ? '!!' + model.formName : '')}</div>` +
      `<div class="form-body${state.grid ? ' grid' : ''}" id="formBody" style="height:${H}px;${gridStyle}">${body}` +
      `<div id="ghost"></div><div id="guideX" class="guide gx"></div><div id="guideY" class="guide gy"></div></div></div>`;

    const total = layout.gadgets.length, approx = layout.gadgets.filter(g => g.approx).length;
    $('status').textContent = `${T('Гаджетов', 'Gadgets')}: ${total}` + (approx ? ` · ${T('приблизительно', 'approximate')}: ${approx}` : '') +
      ` · ${layout.varChars ? 'VarChars' : 'FixChars'} · ` +
      T('Del — удалить, стрелки — сдвиг (Shift ×4), двойной щелчок — callback, Alt+щелчок — элемент под ним · раскладка оценочная, итог — в E3D',
        'Del — delete, arrows — move (Shift ×4), double-click — callback, Alt+click — gadget underneath · layout is approximate, check in E3D');
  }

  /** Координаты мыши → единицы сетки формы. */
  function toUnits(ev) {
    const r = $('formBody').getBoundingClientRect();
    return { x: (ev.clientX - r.left) / kx(), y: (ev.clientY - r.top) / ky() };
  }

  /** gadget — сам anc или вложен в него. */
  function isInside(g, anc, map) {
    for (let cur = g; cur; cur = parentOf(cur, map)) if (cur === anc) return true;
    return false;
  }

  /** Подсветка контейнера, куда будет перенесён гаджет: frame/страница (объект), 'form' или null — снять. */
  function markDropTarget(t) {
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!t) return;
    let el = t === 'form' ? $('formBody') : document.querySelector(`#canvas .g[data-line="${t.line}"]`);
    // страница tabset рисуется без рамки — подсвечиваем сам tabset
    if (t !== 'form' && t.page) el = document.querySelector(`#canvas .g[data-line="${byName().get(t.page.tabset.toLowerCase())?.line}"]`) || el;
    if (el) el.classList.add('drop-target');
  }

  /**
   * Контейнер под точкой (единицы): самый глубокий видимый frame; для tabset — его активная страница.
   * exclude — перетаскиваемый гаджет: он сам и его содержимое контейнером быть не могут.
   */
  function containerAt(pt, exclude) {
    const { layout } = state.data;
    const map = byName();
    let best = null, bestD = -1;
    for (const g of layout.gadgets) {
      if (g.type !== 'frame' || isHidden(g, map) || g.readOnly) continue;
      if (exclude && isInside(g, exclude, map)) continue;
      const b = g.box;
      if (pt.x < b.x || pt.y < b.y || pt.x > b.x + b.w || pt.y > b.y + b.h) continue;
      let cand = g;
      if (g.sub === 'tabset') {
        cand = layout.gadgets.find(p => p.page && p.page.tabset === g.name && p.page.index === (state.activePage[g.name] ?? 0));
        if (!cand) continue;
      }
      const d = depth(cand, map);
      if (d > bestD) { best = cand; bestD = d; }
    }
    return best;
  }

  /** Начало сетки содержимого контейнера в единицах формы. */
  function contentOrigin(frame) {
    if (!frame) {
      const any = state.data.layout.gadgets.find(g => !g.parent);
      return any ? any.origin : { x: 0.5, y: 0.25 };
    }
    return { x: frame.box.x + (frame.content?.dx ?? 0), y: frame.box.y + (frame.content?.dy ?? 0) };
  }

  // ---------- Мышь на холсте: выбор, перемещение, размер, вставка ----------
  const canvasEl = $('canvas');
  canvasEl.addEventListener('mousedown', e => {
    if (e.button !== 0 || !state.data || state.pending) return;
    const addPage = e.target.closest('[data-addpage]');
    if (addPage) { op({ op: 'addPage', line: +addPage.dataset.addpage }); e.preventDefault(); return; }
    const tab = e.target.closest('.tab');
    if (tab) {
      state.activePage[tab.dataset.tabset] = +tab.dataset.page;
      persist();
      select(+tab.dataset.line, true);
      return;
    }
    // вставка выбранного элемента щелчком
    if (state.armedTool && e.target.closest('#formBody')) {
      insertAt(state.armedTool, toUnits(e));
      state.armedTool = null;
      renderToolbox();
      e.preventDefault();
      return;
    }
    const el = e.target.closest('.g');
    if (!el) return;
    // Alt+щелчок — следующий гаджет под курсором (наложенные гаджеты/frame), по кругу; без перетаскивания
    if (e.altKey) {
      const stack = [...new Set(document.elementsFromPoint(e.clientX, e.clientY).map(x => x.closest && x.closest('#canvas .g')).filter(Boolean))]
        .filter(x => !x.classList.contains('hidden-page'));
      if (stack.length) {
        const i = stack.findIndex(x => +x.dataset.line === state.selLine);
        select(+stack[(i + 1) % stack.length].dataset.line, true);
      }
      e.preventDefault();
      return;
    }
    const line = +el.dataset.line;
    const g = state.data.layout.gadgets.find(x => x.line === line);
    if (state.selLine !== line) select(line, true);
    $('canvasWrap').focus({ preventScroll: true });
    if (!g || g.readOnly || g.page) return;
    const handle = e.target.closest('.h');
    state.drag = {
      kind: handle ? 'resize' : 'move', h: handle?.dataset.h, g, start: toUnits(e), startPx: { x: e.clientX, y: e.clientY },
      moved: false, box: { ...g.box },
    };
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    const d = state.drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startPx.x) + Math.abs(e.clientY - d.startPx.y) < 4) return;
    d.moved = true;
    const p = toUnits(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const ghost = $('ghost');
    if (d.kind === 'move') {
      // контейнер под курсором: другой frame / страница / форма → перенос (reparent)
      // цель — контейнер под курсором (как в WinForms); подсвечивается зелёным
      const target = containerAt(p, d.g);
      const targetName = target ? target.name : '';
      markDropTarget(targetName.toLowerCase() !== d.g.parent.toLowerCase() ? (target || 'form') : null);
      if (targetName.toLowerCase() !== d.g.parent.toLowerCase()) {
        const o = contentOrigin(target);
        const ax = d.g.box.x + snapX(dx), ay = d.g.box.y + snapY(dy);
        // в новом контейнере — не левее/выше начала его сетки
        d.reparent = { parentLine: target ? target.line : null, x: r2(Math.max(0, snapX(ax - o.x))), y: r2(Math.max(0, snapY(ay - o.y))) };
        ghost.style.cssText = `display:block;left:${sx(o.x + d.reparent.x)}px;top:${sy(o.y + d.reparent.y)}px;width:${sx(d.box.w)}px;height:${sy(d.box.h)}px`;
        showGuide('guideX', null); showGuide('guideY', null);
        $('status').textContent = `.${d.g.name} → ${target ? '.' + target.name : T('форма', 'form')}: x ${d.reparent.x}  y ${d.reparent.y} ` +
          T('(перенос в другой контейнер)', '(move to another container)');
        return;
      }
      d.reparent = null;
      const origin = d.g.origin;
      // округляется сдвиг (а не позиция) — у относительных координат смещение остаётся «круглым»
      let lx = d.g.local.x + snapX(dx), ly = d.g.local.y + snapY(dy);
      // направляющие: левый/верхний край к краям соседей того же контейнера (выравнивание и «вплотную/с зазором»)
      d.snapX = d.snapY = undefined;
      let bx = 6 / kx(), by = 6 / ky();
      if (!e.altKey) for (const s of siblings(d.g)) {
        const x0 = s.box.x - origin.x, y0 = s.box.y - origin.y;
        // привязка по оси — только если гаджет по ней сдвинут
        if (Math.abs(snapX(dx)) > 1e-9) for (const [pos, edge] of [[x0, 'min'], [x0 + s.box.w, 'max'], [x0 + s.box.w + 1, 'max']]) {
          const dist = Math.abs(d.g.local.x + dx - pos);
          if (dist < bx) { bx = dist; lx = pos; d.snapX = { ref: s.name, edge }; }
        }
        if (Math.abs(snapY(dy)) > 1e-9) for (const [pos, edge] of [[y0, 'min'], [y0 + s.box.h, 'max'], [y0 + s.box.h + 0.25, 'max']]) {
          const dist = Math.abs(d.g.local.y + dy - pos);
          if (dist < by) { by = dist; ly = pos; d.snapY = { ref: s.name, edge }; }
        }
      }
      // привязка, вернувшая ось на исходное место, — не меняет запись этой оси
      if (d.snapX && Math.abs(lx - d.g.local.x) < 1e-6) d.snapX = undefined;
      if (d.snapY && Math.abs(ly - d.g.local.y) < 1e-6) d.snapY = undefined;
      d.nx = r2(lx); d.ny = r2(ly);
      ghost.style.cssText = `display:block;left:${sx(origin.x + lx)}px;top:${sy(origin.y + ly)}px;width:${sx(d.box.w)}px;height:${sy(d.box.h)}px`;
      showGuide('guideX', d.snapX ? sx(origin.x + lx) : null);
      showGuide('guideY', d.snapY ? sy(origin.y + ly) : null);
      // привязка к гаджету НИЖЕ по тексту невозможна (E3D его ещё не знает) — выравнивание будет записано абсолютным числом
      const later = s => { const r = s && state.data.layout.gadgets.find(x => x.name === s.ref); return !!r && r.line > d.g.line; };
      const snapText = (axis, s) => !s ? '' : later(s) ? `  ${axis === 'x' ? '⟷' : '↕'} ` + T(`по .${s.ref} → абс. (.${s.ref} ниже по тексту)`, `to .${s.ref} → abs. (.${s.ref} is later in the file)`) : `  ${axis === 'x' ? '⟷' : '↕'} ${axis}${s.edge} .${s.ref}`;
      $('guideX').classList.toggle('abs', later(d.snapX));
      $('guideY').classList.toggle('abs', later(d.snapY));
      $('status').textContent = `.${d.g.name}: x ${d.nx}  y ${d.ny}` + snapText('x', d.snapX) + snapText('y', d.snapY) + T('  (Alt — без привязки)', '  (Alt — no snapping)');
    } else {
      const w = d.h.includes('e') ? Math.max(1, snapX(d.box.w + dx)) : d.box.w;
      const h = d.h.includes('s') ? Math.max(0.5, snapY(d.box.h + dy)) : d.box.h;
      d.nw = r2(w); d.nh = r2(h);
      ghost.style.cssText = `display:block;left:${sx(d.box.x)}px;top:${sy(d.box.y)}px;width:${sx(w)}px;height:${sy(h)}px`;
      $('status').textContent = T(`.${d.g.name}: ширина ${d.nw}  высота ${d.nh} (рамка гаджета, единицы сетки)`,
        `.${d.g.name}: width ${d.nw}  height ${d.nh} (gadget box, grid units)`);
    }
  });

  window.addEventListener('mouseup', () => {
    const d = state.drag;
    state.drag = null;
    if (!d || !d.moved) return;
    $('ghost').style.display = 'none';
    showGuide('guideX', null); showGuide('guideY', null);
    markDropTarget(null);
    if (d.kind === 'move' && d.reparent) {
      op({ op: 'reparent', line: d.g.line, ...d.reparent, defaultMode: state.newMode });
    } else if (d.kind === 'move') {
      op({ op: 'move', line: d.g.line, x: d.nx, y: d.ny, mode: 'keep', defaultMode: state.newMode, snapX: d.snapX, snapY: d.snapY });
    } else {
      op({ op: 'resize', line: d.g.line, w: d.h.includes('e') ? d.nw : undefined, h: d.h.includes('s') ? d.nh : undefined });
    }
  });

  function showGuide(id, px) {
    const el = $(id);
    if (!el) return;
    if (px === null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (id === 'guideX') el.style.left = px + 'px'; else el.style.top = px + 'px';
  }

  function siblings(g) {
    const map = byName();
    return state.data.layout.gadgets.filter(s => s !== g && s.name && s.parent === g.parent && !s.page && !isHidden(s, map));
  }

  canvasEl.addEventListener('dblclick', e => {
    const el = e.target.closest('.g');
    if (!el || e.target.closest('.tab')) return;
    op({ op: 'callback', line: +el.dataset.line, placement: 'init' });
  });

  // ---------- Панель элементов ----------
  function renderToolbox() {
    document.querySelectorAll('.tool').forEach(t => t.classList.toggle('armed', t.dataset.type === state.armedTool));
    canvasEl.classList.toggle('armed', !!state.armedTool);
  }
  $('toolbox').addEventListener('click', e => {
    const t = e.target.closest('.tool');
    if (!t) return;
    state.armedTool = state.armedTool === t.dataset.type ? null : t.dataset.type;
    renderToolbox();
  });
  $('toolbox').addEventListener('dragstart', e => {
    const t = e.target.closest('.tool');
    if (t) e.dataTransfer.setData('text/x-pml-gadget', t.dataset.type);
  });
  canvasEl.addEventListener('dragover', e => { if (e.target.closest('#formBody')) e.preventDefault(); });
  canvasEl.addEventListener('drop', e => {
    const type = e.dataTransfer.getData('text/x-pml-gadget');
    if (!type || !e.target.closest('#formBody')) return;
    e.preventDefault();
    insertAt(type, toUnits(e));
  });

  function insertAt(type, pt) {
    const cont = containerAt(pt);
    const o = contentOrigin(cont);
    op({ op: 'add', type, parentLine: cont ? cont.line : null, x: r2(snapX(pt.x - o.x)), y: r2(snapY(pt.y - o.y)), mode: state.newMode });
  }

  // ---------- Клавиатура ----------
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === 'Escape' && state.armedTool) { state.armedTool = null; renderToolbox(); return; }
    if (state.selLine === null || !state.data || state.pending) return;
    const g = state.data.layout.gadgets.find(x => x.line === state.selLine);
    if (!g || g.readOnly) return;
    if (e.key === 'Delete') { op({ op: 'delete', line: g.line }); e.preventDefault(); return; }
    const k = e.shiftKey ? 4 : 1;
    const mv = { ArrowLeft: [-STEP_X * k, 0], ArrowRight: [STEP_X * k, 0], ArrowUp: [0, -STEP_Y * k], ArrowDown: [0, STEP_Y * k] }[e.key];
    if (mv && !g.page) {
      // сдвиг, а не позиция: расширение считает его от свежей раскладки
      op({ op: 'nudge', line: g.line, dx: mv[0], dy: mv[1], defaultMode: state.newMode });
      e.preventDefault();
    }
  });

  // ---------- Свойства ----------
  function renderProps() {
    // после перерисовки вернуть фокус в то же поле (правка по Enter не должна «выбрасывать» из панели)
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#props .pf');
    const focusProp = focused ? focused.dataset.prop : null;
    renderPropsInner();
    if (focusProp) {
      const el = document.querySelector(`#props .pf[data-prop="${focusProp}"]`);
      if (el && !el.disabled) { el.focus(); el.select(); }
    }
  }

  function renderPropsInner() {
    const p = state.data && state.selLine !== null ? state.data.props[state.selLine] : null;
    if (!p) { $('props').innerHTML = `<div class="empty">${T('Выберите гаджет на холсте или в дереве', 'Select a gadget on the canvas or in the tree')}</div>`; return; }
    const ro = !!p.readOnly;
    const dis = ro ? ' disabled' : '';
    const field = (label, prop, value, hint = '') =>
      `<tr><td>${label}</td><td><input class="pf" data-prop="${prop}" value="${esc(value ?? '')}" placeholder="${esc(hint)}"${dis}></td></tr>`;
    const modeLabel = EN ? { abs: 'abs.', rel: 'rel.', auto: 'auto', complex: 'expression' } : { abs: 'абс.', rel: 'отн.', auto: 'авто', complex: 'выражение' };
    const posMode = p.xMode === 'complex' || p.yMode === 'complex' ? 'complex'
      : (p.xMode === 'rel' || p.yMode === 'rel') ? 'rel' : (p.xMode === 'abs' || p.yMode === 'abs') ? 'abs' : 'auto';
    const cbInCode = p.callbackInCode.map(c => `<code>${esc(c.value)}</code> <span class="link" data-goto="${c.line}">${T('в', 'in')} .${esc(c.method ?? '?')}() :${c.line + 1}</span>`).join('<br>');
    const flagBox = (flag, label) => `<label class="chk"><input type="checkbox" data-flag="${flag}"${p.flags.includes(flag) ? ' checked' : ''}${dis}> ${label}</label>`;
    const isTabset = p.type === 'frame' && p.flags.includes('tabset');
    const boxed = p.type === 'list' || p.type === 'textpane' || p.type === 'selector';
    $('props').innerHTML =
      `<h4>${esc(p.type)}${isTabset ? ' tabset' : ''} .${esc(p.name)}</h4>` +
      (ro ? `<div class="banner">${esc(p.readOnly)}</div>` : '') +
      '<table>' +
      field(T('Имя', 'Name'), 'name', p.name) +
      // para: видимый текст — TEXT (tag не отображается); slider/line: tag не отображается (Справочник 12.1)
      (p.type === 'paragraph' ? field(T('Текст', 'Text'), 'text', p.text ?? '') :
        isTabset || p.type === 'slider' || p.type === 'line' ? '' : field(p.isPage ? T('Вкладка', 'Tab') : 'Tag', 'tag', p.tag ?? '')) +
      (p.isPage ? '' :
        `<tr><td>${T('Позиция', 'Position')}</td><td><span class="seg small">` +
        `<button class="segb${posMode === 'rel' ? ' on' : ''}" data-setmode="rel"${dis}>${T('Отн.', 'Rel.')}</button>` +
        `<button class="segb${posMode === 'abs' ? ' on' : ''}" data-setmode="abs"${dis}>${T('Абс.', 'Abs.')}</button></span>` +
        ` <span class="muted">x: ${modeLabel[p.xMode]}, y: ${modeLabel[p.yMode]}</span></td></tr>` +
        field('X', 'x', p.x, T('авто (path)', 'auto (path)')) + field('Y', 'y', p.y, T('авто (path)', 'auto (path)'))) +
      field(T('Ширина', 'Width'), 'width', p.width, T('по умолчанию', 'default')) +
      field(boxed ? T('Строк', 'Lines') : T('Высота', 'Height'), 'height', p.height, T('по умолчанию', 'default')) +
      (p.isPage ? '' : field('Callback', 'callback', p.callback ?? (p.callbackInCode[0]?.value ?? ''), T('!this.метод()', '!this.method()'))) +
      (cbInCode ? `<tr><td>${T('в коде', 'in code')}</td><td>${cbInCode}</td></tr>` : '') +
      (p.isPage ? '' : field('Tooltip', 'tooltip', p.tooltip ?? '') + field('Anchor', 'anchor', p.anchor ?? '', T('напр. l+r+t', 'e.g. l+r+t')) + field('Dock', 'dock', p.dock ?? '', T('напр. fill', 'e.g. fill'))) +
      (p.type === 'list' ? `<tr><td>${T('Выбор', 'Selection')}</td><td>${flagBox('multiple', 'multiple')}</td></tr>` : '') +
      (p.type === 'button' ? `<tr><td>${T('Вид', 'Style')}</td><td>${flagBox('linklabel', 'linklabel')}</td></tr>` : '') +
      (p.extras.length ? `<tr><td>${T('Прочее', 'Other')}</td><td>${p.extras.map(f => `<code>${esc(f)}</code>`).join(' ')}</td></tr>` : '') +
      `<tr><td>${T('Строка', 'Line')}</td><td><span class="link" data-goto="${p.line}">${p.line + 1}</span></td></tr>` +
      '</table>' +
      '<div class="actions">' +
      (isTabset && !ro ? `<button class="act" data-act="addPage">${T('+ страница', '+ page')}</button>` : '') +
      (!ro && !p.isPage ? `<button class="act" data-act="callback" title="${T('Двойной щелчок по гаджету', 'Double-click the gadget')}">Callback ↗</button>` : '') +
      (!ro ? `<button class="act danger" data-act="delete" title="Del">${T('Удалить', 'Delete')}</button>` : '') +
      '</div>' +
      `<div class="src">${esc(p.source)}</div>`;
  }

  const propsEl = $('props');
  propsEl.addEventListener('click', e => {
    const a = e.target.closest('[data-goto]');
    if (a) { vscode.postMessage({ type: 'reveal', line: +a.dataset.goto }); return; }
    const m = e.target.closest('[data-setmode]');
    if (m && state.selLine !== null) { op({ op: 'setMode', line: state.selLine, mode: m.dataset.setmode }); return; }
    const act = e.target.closest('[data-act]');
    if (act && state.selLine !== null) {
      const line = state.selLine;
      if (act.dataset.act === 'addPage') op({ op: 'addPage', line });
      if (act.dataset.act === 'callback') op({ op: 'callback', line, placement: 'init' });
      if (act.dataset.act === 'delete') op({ op: 'delete', line });
    }
  });
  propsEl.addEventListener('change', e => {
    const f = e.target.closest('[data-flag]');
    if (f && state.selLine !== null) op({ op: 'setProp', line: state.selLine, prop: f.dataset.flag, value: String(f.checked) });
  });
  // поле: запись по Enter и при уходе с поля (если значение изменилось); Esc — отмена
  const commit = input => {
    const p = state.data.props[state.selLine];
    if (!p) return;
    const prop = input.dataset.prop;
    const old = prop === 'callback' ? (p.callback ?? p.callbackInCode[0]?.value ?? '') : (p[prop] ?? '');
    if (input.value === String(old)) return;
    op({ op: 'setProp', line: state.selLine, prop, value: input.value });
  };
  propsEl.addEventListener('keydown', e => {
    const input = e.target.closest('.pf');
    if (!input) return;
    if (e.key === 'Enter') { commit(input); e.preventDefault(); }
    if (e.key === 'Escape') { renderProps(); }
  });
  propsEl.addEventListener('focusout', e => { const input = e.target.closest('.pf'); if (input) commit(input); });

  // ---------- Выделение ----------
  function openPagesFor(g) {
    const map = byName();
    let changed = false;
    for (let cur = g; cur; cur = parentOf(cur, map)) {
      if (cur.page && (state.activePage[cur.page.tabset] ?? 0) !== cur.page.index) { state.activePage[cur.page.tabset] = cur.page.index; changed = true; }
    }
    if (changed) persist();
  }

  function select(line, reveal) {
    state.selLine = line;
    persist();
    const g = state.data?.layout.gadgets.find(x => x.line === line);
    if (g) openPagesFor(g);
    renderTree();
    renderCanvas();
    renderProps();
    const el = document.querySelector(`#canvas .g[data-line="${line}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const tr = document.querySelector(`#tree .row[data-line="${line}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
    if (reveal) vscode.postMessage({ type: 'reveal', line });
  }

  /** Курсор в коде: выделить гаджет, в строках которого стоит курсор (самый вложенный). */
  function selectByCursor(line) {
    if (!state.data || state.drag) return;
    let best = null;
    for (const p of Object.values(state.data.props)) {
      if (line >= p.line && line <= p.endLine && (!best || p.line > best.line)) best = p;
    }
    if (best && best.line !== state.selLine) select(best.line, false);
  }

  vscode.postMessage({ type: 'ready' });
})();
