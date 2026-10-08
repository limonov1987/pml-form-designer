import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decodeFile, encodeUtf8Bom } from '../core/encoding';
import { tokenize } from '../core/lexer';
import { parseGadgetLine } from '../core/gadget';
import { parseForm, printLines, walkGadgets, GadgetNode } from '../core/form';
import { applyEdits, setPosition, setSize, setTag, setCallback, renameGadget, addMethodStub, deleteGadget,
    detectStyle, formatCoord, parseCoordText, setFlag, setTooltip, newGadgetLines, insertionPoint, findReferences, setCallbackInInit, uniqueName } from '../core/edits';

const FORM = [
    'setup form !!demo dialog',
    '\t!this.formTitle = |Демо|',
    '\tpath down',
    '\tbutton .ok |OK| at x0 y0 WID 30',
    '\tbutton .cancel |Отмена| at x0 ymax .ok + 0.5 WID 30',
    '\tframe .fr |Рамка| at xmin.ok ymax',
    '\t\tlist .lst |Список| width 20 hei 5',
    '\texit',
    'exit',
    '',
    'define method .init()',
    '\t!this.ok.callback = |!this.apply()|',
    'endmethod',
    '',
].join('\r\n');

const gadget = (text: string, name: string): GadgetNode => {
    for (const { node } of walkGadgets(parseForm(text).nodes)) if (node.gadget.name === name) return node;
    throw new Error(name);
};

test('кодировки: BOM, UTF-8, cp1251', () => {
    assert.equal(decodeFile(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41])).encoding, 'utf8bom');
    assert.equal(decodeFile(new TextEncoder().encode('Тест')).encoding, 'utf8');
    const cp = decodeFile(new Uint8Array([0xD2, 0xE5, 0xF1, 0xF2, 0xA8]));   // «ТестЁ» в cp1251
    assert.deepEqual(cp, { text: 'ТестЁ', encoding: 'cp1251' });
    assert.deepEqual([...encodeUtf8Bom('A')], [0xEF, 0xBB, 0xBF, 0x41]);
});

test('лексер: строки, экранирование, имена, макросы', () => {
    const t = tokenize(`button .a 'it''s' |x| xmin.b $!w !this.c -- комм`);
    assert.deepEqual(t.map(x => x.kind), ['word', 'name', 'string', 'string', 'word', 'macro', 'var', 'comment']);
    assert.equal(t[2].value, "it''s");
});

test('гаджет: позиция, размеры, сокращения', () => {
    const g = parseGadgetLine(`button .ok linkl |OK| at xmax form-size ymax.fr+0.5 wid 10 hei 2 call |!this.go()| anchor l+b`)!;
    assert.equal(g.type, 'button');
    assert.equal(g.tag, 'OK');
    assert.deepEqual(g.flags, ['linklabel']);
    assert.deepEqual([g.at!.x!.ref, g.at!.x!.edge, g.at!.x!.minusSize], ['form', 'max', true]);
    assert.deepEqual([g.at!.y!.ref, g.at!.y!.value], ['fr', 0.5]);
    assert.equal(g.width!.value, 10);
    assert.equal(g.callback, '!this.go()');
    assert.equal(g.anchor, 'l+b');
    assert.equal(g.extras.length, 0);
});

test('гаджет: старая запись xmin_gad, слитное смещение, ymax .gad + 0.5', () => {
    const g = parseGadgetLine(`button .m '-' at xmin_sess-3 ymax .ok + 0.5`)!;
    assert.deepEqual([g.at!.x!.ref, g.at!.x!.value], ['sess', -3]);
    assert.deepEqual([g.at!.y!.ref, g.at!.y!.value], ['ok', 0.5]);
    const h = parseGadgetLine(`button .n at xmax0.5 ymin`)!;
    assert.equal(h.at!.x!.value, 0.5);
});

test('форма: печать без потерь и структура', () => {
    const doc = parseForm(FORM);
    assert.equal(printLines(doc.lines), FORM);
    assert.equal(doc.formName, 'demo');
    assert.equal(doc.setupEndLine, 8);
    const names = [...walkGadgets(doc.nodes)].map(x => `${x.parent?.gadget.name ?? ''}/${x.node.gadget.name}`);
    assert.deepEqual(names, ['/ok', '/cancel', '/fr', 'fr/lst']);
    assert.deepEqual(doc.callbackAssigns.map(c => [c.gadget, c.method]), [['ok', 'init']]);
});

test('форма: rgroup и меню PML2 без exit', () => {
    const doc = parseForm(['setup form !!f', 'menu .pm', '!this.pm.add(|CALLBACK|,|A|,|x|)', 'rgroup .r |R|', 'add tag |A| select |A|',
        'button .b |B|', 'exit', 'define method .f()', 'endmethod'].join('\n'));
    assert.equal(doc.setupEndLine, 6);
    assert.deepEqual(doc.problems, []);
});

test('правки: точечная замена позиции сохраняет остальной текст', () => {
    const n = gadget(FORM, 'cancel');
    const lines = applyEdits(parseForm(FORM).lines, [setPosition(n, { ...n.gadget.at!.x!, mode: 'abs', value: 2 }, n.gadget.at!.y)]);
    assert.equal(lines[4].text, '\tbutton .cancel |Отмена| at x2 ymax .ok + 0.5 WID 30');
});

test('правки: размер с сохранением ключевого слова, tag, callback', () => {
    const doc = parseForm(FORM);
    const n = gadget(FORM, 'ok');
    const lines = applyEdits(doc.lines, [
        setSize(n, 'width', { mode: 'abs', value: 12, raw: '' }),
        setTag(n, 'Применить'),
        setCallback(n, '!this.okCb()'),
    ]);
    assert.equal(lines[3].text, '\tbutton .ok |Применить| at x0 y0 callback |!this.okCb()| WID 12');   // B11: callback перед width
});

test('правки: переименование обновляет ссылки по файлу', () => {
    const doc = parseForm(FORM);
    const lines = applyEdits(doc.lines, renameGadget(doc, gadget(FORM, 'ok'), 'apply'));
    assert.equal(lines[3].text, '\tbutton .apply |OK| at x0 y0 WID 30');
    assert.equal(lines[4].text, '\tbutton .cancel |Отмена| at x0 ymax .apply + 0.5 WID 30');
    assert.equal(lines[5].text, '\tframe .fr |Рамка| at xmin.apply ymax');
    assert.equal(lines[11].text, '\t!this.apply.callback = |!this.apply()|');
});

test('правки: заглушка метода и удаление frame вместе с содержимым', () => {
    const doc = parseForm(FORM);
    const lines = applyEdits(doc.lines, [addMethodStub(doc, 'okCb')!, deleteGadget(gadget(FORM, 'fr'))]);
    const text = printLines(lines);
    assert.ok(text.includes('define method .okCb()\r\nendmethod'));
    assert.ok(!text.includes('.lst'));
    assert.equal(addMethodStub(doc, 'INIT'), undefined);
});

import { layoutForm } from '../core/layout';

test('раскладка: path down, AT относительно гаджета, frame растёт по содержимому', () => {
    const doc = parseForm([
        'setup form !!f dialog',
        'path down',
        'button .a |A| width 10',
        'button .b |B| width 10',
        'button .c |C| at xmax.a+1 ymin.a width 5',
        'frame .fr |F| at x0 ymax.b+1',
        '  list .l width 20 height 4',
        'exit',
        'exit',
    ].join('\n'));
    const L = layoutForm(doc);
    const g = (n: string) => L.gadgets.find(x => x.name === n)!;
    assert.equal(g('b').local.x, g('a').local.x);                       // path down: тот же x
    assert.ok(g('b').local.y > g('a').local.y + g('a').box.h - 1e-9);    // ниже a
    assert.equal(g('c').local.x, g('a').local.x + 10 + 1);              // xmax.a+1
    assert.equal(g('c').local.y, g('a').local.y);                       // ymin.a
    assert.ok(g('fr').box.w >= g('l').box.w);                            // frame вмещает list
    assert.equal(g('l').parent, 'fr');
    assert.ok(!L.gadgets.some(x => x.approx));
});

test('раскладка: страницы tabset совпадают по положению', () => {
    const doc = parseForm(['setup form !!f', 'frame .ts tabset', 'frame .p1 |Один|', 'button .x |X|', 'exit',
        'frame .p2 |Два|', 'button .y |Y|', 'exit', 'exit', 'exit'].join('\n'));
    const L = layoutForm(doc);
    const g = (n: string) => L.gadgets.find(x => x.name === n)!;
    assert.deepEqual([g('p1').box.x, g('p1').box.y], [g('p2').box.x, g('p2').box.y]);
    assert.deepEqual([g('p1').page?.index, g('p2').page?.index], [0, 1]);
});

test('B11: callback и tooltip вставляются перед width у option', () => {
    const doc = parseForm(['setup form !!f', "option .o 'Тег' tagwid 14 at x0 y0 width 18", 'exit'].join('\n'));
    const n = [...walkGadgets(doc.nodes)][0].node;
    const lines = applyEdits(doc.lines, [setCallback(n, '!this.go()'), setTooltip(n, 'Подсказка')]);
    assert.equal(lines[1].text, "option .o 'Тег' tagwid 14 at x0 y0 callback |!this.go()| tooltip |Подсказка| width 18");
});

test('стиль координат: по файлу и ввод текста', () => {
    const compact = parseForm(['setup form !!f', 'button .a |A| at xmin.b+1 ymax.b+0.5', 'button .b |B| at xmax.a+1 ymin.a', 'exit'].join('\n'));
    assert.equal(detectStyle(compact).spaced, false);
    assert.equal(detectStyle(parseForm(FORM)).spaced, true);
    const c = parseCoordText('x', 'xmax .bnApply + 1')!;
    assert.deepEqual([c.mode, c.edge, c.ref, c.value], ['rel', 'max', 'bnApply', 1]);
    assert.equal(formatCoord(c, { spaced: false }), 'xmax.bnApply+1');
    assert.equal(parseCoordText('x', 'xmax .a + бред'), undefined);
});

test('флаг list multiple: включение после тега, выключение', () => {
    const n = gadget(FORM, 'lst');
    const doc = parseForm(FORM);
    assert.equal(applyEdits(doc.lines, [setFlag(n, 'multiple', true)])[6].text, '\t\tlist .lst |Список| multiple width 20 hei 5');
    const on = parseForm(printLines(applyEdits(doc.lines, [setFlag(n, 'multiple', true)])));
    const n2 = [...walkGadgets(on.nodes)].find(x => x.node.gadget.name === 'lst')!.node;
    assert.equal(applyEdits(on.lines, [setFlag(n2, 'multiple', false)])[6].text, '\t\tlist .lst |Список| width 20 hei 5');
});

test('новый гаджет: имя, место вставки в frame, отступ', () => {
    const doc = parseForm(FORM);
    assert.equal(uniqueName(doc, 'button'), 'button1');
    const fr = gadget(FORM, 'fr');
    const ip = insertionPoint(doc, fr);
    assert.deepEqual(ip, { line: 7, indent: '\t\t' });
    const lines = newGadgetLines('tabset', 'tabset1', 'at x0 ymax', '\t');
    assert.deepEqual(lines, ['frame .tabset1 tabset at x0 ymax wid 30 hei 8', '\tframe .tabset1Page1 |Страница 1|', '\texit', 'exit']);
});

test('ссылки на гаджет и callback в .init() (B5)', () => {
    const doc = parseForm(FORM);
    assert.deepEqual(findReferences(doc, gadget(FORM, 'ok')), [4, 5, 11]);
    const e1 = setCallbackInInit(doc, 'ok', '!this.okClick()')!;           // замена существующего назначения
    assert.equal(applyEdits(doc.lines, [e1])[11].text, '\t!this.ok.callback = |!this.okClick()|');
    const e2 = setCallbackInInit(doc, 'cancel', '!this.cancelClick()')!;   // новое — перед endmethod init
    const out = applyEdits(doc.lines, [e2]);
    assert.equal(out[12].text, '\t!this.cancel.callback = |!this.cancelClick()|');
    assert.equal(out[13].text, 'endmethod');
});

import { execute } from '../core/operations';

const run = (text: string, req: Parameters<typeof execute>[1]) => {
    const r = execute(text, req);
    return { r, text: printLines(applyEdits(parseForm(text).lines, r.edits)) };
};

test('операции: перемещение — abs остаётся abs, rel сохраняет ссылку', () => {
    const a = run(FORM, { op: 'move', line: 3, x: 2, y: 1, mode: 'keep' });
    assert.ok(a.text.includes('\tbutton .ok |OK| at x2 y1 WID 30'), a.text);
    // .cancel: at x0 ymax .ok + 0.5 → сдвиг по Y на +1 меняет только смещение
    const laid = layoutForm(parseForm(FORM)).gadgets.find(g => g.name === 'cancel')!;
    const b = run(FORM, { op: 'move', line: 4, x: laid.local.x, y: laid.local.y + 1, mode: 'keep' });
    assert.ok(b.text.includes('\tbutton .cancel |Отмена| at x0 ymax .ok + 1.5 WID 30'), b.text);
});

test('операции: привязка к краю соседа и переключение abs/rel', () => {
    const L = layoutForm(parseForm(FORM));
    const ok = L.gadgets.find(g => g.name === 'ok')!;
    const a = run(FORM, { op: 'move', line: 4, x: ok.local.x + ok.box.w + 1, y: ok.local.y, mode: 'keep', snapX: { ref: 'ok', edge: 'max' }, snapY: { ref: 'ok', edge: 'min' } });
    assert.ok(a.text.includes('at xmax .ok + 1 ymin .ok WID 30'), a.text);
    const b = run(FORM, { op: 'setMode', line: 4, mode: 'abs' });
    const cancel = L.gadgets.find(g => g.name === 'cancel')!;
    assert.ok(b.text.includes(`at x${cancel.local.x} y${Math.round(cancel.local.y * 10) / 10} WID 30`), b.text);
});

test('операции: добавление в frame (rel от последнего гаджета), tabset со страницей', () => {
    const fr = layoutForm(parseForm(FORM)).gadgets.find(g => g.name === 'lst')!;
    const a = run(FORM, { op: 'add', type: 'button', parentLine: 5, x: fr.local.x, y: fr.local.y + fr.box.h + 0.5, mode: 'rel' });
    assert.equal(a.r.select, 'button1');
    assert.ok(a.text.includes('\t\tlist .lst |Список| width 20 hei 5\r\n\t\tbutton .button1 |Кнопка| at xmin .lst ymax .lst + 0.5 wid 10\r\n\texit'), a.text);
    const b = run(FORM, { op: 'add', type: 'tabset', parentLine: null, x: 0, y: 12, mode: 'abs' });
    assert.ok(b.text.includes('\tframe .tabset1 tabset at x0 y12 wid 30 hei 8\r\n\t\tframe .tabset1Page1 |Страница 1|\r\n\t\texit\r\n\texit\r\nexit'), b.text);
    const doc = parseForm(b.text);
    const ts = [...walkGadgets(doc.nodes)].find(x => x.node.gadget.name === 'tabset1')!.node;
    const c = run(b.text, { op: 'addPage', line: ts.line });
    assert.ok(c.text.includes('\t\tframe .tabset1Page2 |Страница 2|\r\n\t\texit\r\n\texit'), c.text);
});

test('операции: удаление со ссылками требует подтверждения', () => {
    const a = execute(FORM, { op: 'delete', line: 3 });
    assert.ok(a.confirm && a.edits.length === 0);
    const b = run(FORM, { op: 'delete', line: 3, force: true });
    assert.ok(!b.text.includes('button .ok'));
});

test('операции: двойной щелчок — callback в .init() и заглушка; существующий — переход', () => {
    const a = run(FORM, { op: 'callback', line: 4, placement: 'init' });
    assert.equal(a.r.revealMethod, 'cancelCallback');
    assert.ok(a.text.includes('\t!this.cancel.callback = |!this.cancelCallback()|\r\nendmethod'), a.text);
    assert.ok(a.text.includes('define method .cancelCallback()\r\nendmethod'), a.text);
    // у .ok callback уже назначен в init на !this.apply() — метода apply нет → создаётся заглушка apply
    const b = run(FORM, { op: 'callback', line: 3, placement: 'init' });
    assert.equal(b.r.revealMethod, 'apply');
    assert.ok(b.text.includes('define method .apply()'));
});

test('операции: свойства — имя занято, координата текстом, ширина', () => {
    assert.ok(execute(FORM, { op: 'setProp', line: 3, prop: 'name', value: 'cancel' }).error);
    assert.ok(execute(FORM, { op: 'setProp', line: 3, prop: 'name', value: '1bad' }).error);
    const a = run(FORM, { op: 'setProp', line: 4, prop: 'x', value: 'xmax .ok + 2' });
    assert.ok(a.text.includes('at xmax .ok + 2 ymax .ok + 0.5 WID 30'), a.text);
    const b = run(FORM, { op: 'setProp', line: 6, prop: 'width', value: '25' });
    assert.ok(b.text.includes('list .lst |Список| width 25 hei 5'), b.text);
});

test('перенос: button из формы в frame — строка внутри frame, AT от последнего гаджета frame, предупреждение', () => {
    const a = run(FORM, { op: 'reparent', line: 4, parentLine: 5, x: 0, y: 6 });
    assert.equal(a.r.error, undefined);
    const L = a.text.split('\r\n');
    assert.ok(!L.slice(0, 5).some(l => l.includes('.cancel')), 'исходная строка удалена');
    const i = L.findIndex(l => l.includes('button .cancel'));
    assert.match(L[i], /^\t\tbutton \.cancel \|Отмена\| at xmin \.lst ymax \.lst \+ [\d.]+ WID 30$/);
    assert.ok(L[i - 1].includes('list .lst') && /^\texit$/.test(L[i + 1]), L.join('\n'));
    assert.match(a.r.notice ?? '', /\.fr расставлен от предыдущего/);
    assert.equal(a.r.select, 'cancel');
});

test('перенос: list из frame на форму (abs остаётся abs), frame с содержимым — с новым отступом', () => {
    const src = FORM.replace('list .lst |Список| width 20 hei 5', 'list .lst |Список| at x1 y1 width 20 hei 5');
    const a = run(src, { op: 'reparent', line: 6, parentLine: null, x: 3, y: 12 });
    const L = a.text.split('\r\n');
    assert.ok(!L[6].includes('.lst'));
    const i = L.findIndex(l => l.includes('list .lst'));
    assert.equal(L[i], '\tlist .lst |Список| at x3 y12 width 20 hei 5');
    assert.equal(L[i - 1], '\texit');            // после frame .fr (его exit)
    // frame .fr целиком в новый frame .box
    const b0 = FORM.replace('\texit\r\nexit', '\texit\r\n\tframe .box |Box| at x40 y0\r\n\t\tbutton .x |X|\r\n\texit\r\nexit');
    const doc = parseForm(b0);
    const box = [...walkGadgets(doc.nodes)].find(x => x.node.gadget.name === 'box')!.node;
    const b = run(b0, { op: 'reparent', line: 5, parentLine: box.line, x: 0, y: 2, defaultMode: 'abs' });
    assert.ok(b.text.includes('\t\tbutton .x |X|\r\n\t\tframe .fr |Рамка| at xmin .x ymax .x + 1\r\n\t\t\tlist .lst |Список| width 20 hei 5\r\n\t\texit\r\n\texit'), b.text);
});

test('перенос: запреты', () => {
    const ts = FORM.replace('\texit\r\nexit', '\texit\r\n\tframe .ts tabset\r\n\t\tframe .p1 |P1|\r\n\t\texit\r\n\texit\r\nexit');
    assert.match(execute(FORM, { op: 'reparent', line: 5, parentLine: 5, x: 0, y: 0 }).error!, /внутрь самого себя/);
    assert.match(execute(ts, { op: 'reparent', line: 3, parentLine: 8, x: 0, y: 0 }).error!, /tabset/);
    assert.match(execute(ts, { op: 'reparent', line: 9, parentLine: null, x: 0, y: 0 }).error!, /Страница tabset/);
    assert.match(execute(FORM, { op: 'reparent', line: 6, parentLine: 5, x: 0, y: 0 }).error!, /уже в этом/);
    // ссылка вперёд: от .ok позиционируются .cancel и .fr (строки 5, 6) — после переноса .ok окажется ниже них →
    // подтверждение; с force — их позиция становится абсолютной и перенос выполняется
    const q = execute(ts, { op: 'reparent', line: 3, parentLine: 9, x: 0, y: 0 });
    assert.match(q.confirm ?? '', /От \.ok позиционируются \.cancel, \.fr/);
    const f = run(ts, { op: 'reparent', line: 3, parentLine: 9, x: 0, y: 0, force: true });
    const L = layoutForm(parseForm(ts)).gadgets;
    const can = L.find(x => x.name === 'cancel')!, fr = L.find(x => x.name === 'fr')!;
    assert.ok(f.text.includes(`\tbutton .cancel |Отмена| at x0 y${Math.round(can.local.y * 100) / 100} WID 30`), f.text);
    // у .fr от .ok зависел только X (xmin.ok) — Y (ymax предыдущего) не трогается
    assert.ok(f.text.includes(`\tframe .fr |Рамка| at x${Math.round(fr.local.x * 100) / 100} ymax\r\n`), f.text);
    assert.ok(f.text.includes('\t\tframe .p1 |P1|\r\n\t\t\tbutton .ok |OK| at x0 y0 WID 30\r\n\t\texit'), f.text);
    assert.match(f.r.notice ?? '', /переведена в абсолютную/);
    // на страницу tabset — можно (на .lst никто не ссылается)
    const ok = run(ts, { op: 'reparent', line: 6, parentLine: 9, x: 1, y: 0 });
    assert.equal(ok.r.error, undefined);
    assert.ok(ok.text.includes('\t\tframe .p1 |P1|\r\n\t\t\tlist .lst |Список| at x1 y0 width 20 hei 5\r\n\t\texit'), ok.text);
});

test('перенос: ссылки ниже нового места — разрешено с предупреждением', () => {
    // .b ниже по тексту ссылается на .a; .a переносим в frame .fr, который стоит выше .b
    const src = ['setup form !!f', 'frame .fr |F| at x0 y0', 'exit', 'button .a |A| at x20 y0', 'button .b |B| at xmin .a ymax .a', 'exit'].join('\r\n');
    const r = run(src, { op: 'reparent', line: 3, parentLine: 1, x: 0, y: 0 });
    assert.equal(r.r.error, undefined);
    assert.match(r.r.notice ?? '', /на \.a ссылаются строки 5/);
    assert.ok(r.text.includes('frame .fr |F| at x0 y0\r\n    button .a |A| at x0 y0\r\nexit'), r.text);   // B4: 4 пробела
});

test('if/do в setup: условный гаджет не переносится, вставка — после endif', () => {
    const src = ['setup form !!f', 'frame .fr |F| at x0 y0', 'exit', 'button .a |A| at x20 y0', 'if (!x) then', '  button .b |B| at x30 y0', 'endif', 'exit'].join('\r\n');
    const doc = parseForm(src);
    const b = [...walkGadgets(doc.nodes)].find(x => x.node.gadget.name === 'b')!.node;
    assert.equal(b.conditional, true);
    assert.match(execute(src, { op: 'reparent', line: 5, parentLine: 1, x: 0, y: 0 }).error!, /if\/do/);
    // .a из формы во frame и обратно; новый гаджет на форму — после endif
    const r = run(src, { op: 'add', type: 'button', parentLine: null, x: 0, y: 5, mode: 'abs' });
    assert.ok(r.text.includes('endif\r\nbutton .button1 |Кнопка| at x0 y5 wid 10\r\nexit'), r.text);
});

test('rgroup без exit: перенос и удаление ставят явный exit (иначе exit контейнера закроет rgroup)', () => {
    const src = ['setup form !!f', 'frame .fr |F| at x0 y0', '  button .z |Z|', 'exit',
        "rgroup .rg '' frame vertical at x0 y5", "  add tag 'A' select 'A'", "  add tag 'B' select 'B'", 'button .b |B| at x20 y5', 'exit'].join('\r\n');
    // перенос rgroup во frame: после его add — явный exit
    const a = run(src, { op: 'reparent', line: 4, parentLine: 1, x: 0, y: 2 });
    assert.ok(a.text.includes("  button .z |Z|\r\n  rgroup .rg '' frame vertical at x0 y2\r\n    add tag 'A' select 'A'\r\n    add tag 'B' select 'B'\r\n  exit\r\nexit"), a.text);
    // удаление .b, неявно закрывавшего rgroup: на его месте — exit rgroup
    const d = run(src, { op: 'delete', line: 7 });
    assert.ok(d.text.includes("  add tag 'B' select 'B'\r\nexit\r\nexit"), d.text);
    const doc = parseForm(d.text);
    assert.equal(doc.setupEndLine, 8);
    assert.deepEqual(doc.problems, []);
});

import { newFormText, validateFormName, formNameWarning, formFileName } from '../core/template';

test('новая форма: шаблоны разбираются, есть шапка B2, конструктор и .init()', () => {
    for (const kind of ['dialog', 'dialog docking right', 'dialog docking left', 'document'] as const) {
        for (const template of ['empty', 'applyClose'] as const) {
            const text = newFormText({ name: 'bnpTest', kind, resize: kind === 'dialog', title: 'Проверка | символ', developer: 'Тест', date: '2026-10-08', template });
            const doc = parseForm(text);
            assert.deepEqual(doc.problems, []);
            assert.deepEqual(doc.warnings, []);
            assert.equal(doc.formName, 'bnpTest');
            assert.ok(text.startsWith('------------------------------------------------------------------------\r\n-- File:        bnptest.pmlfrm\r\n'));
            assert.ok(text.includes('-- show !!bnpTest / pml reload form !!bnpTest'));
            assert.ok(text.includes("    !this.formTitle = 'Проверка | символ'"));   // с | внутри — в '…'
            assert.ok(text.includes('    !this.initCall  = |!this.init()|'));
            assert.deepEqual(doc.methods.map(m => m.name), template === 'empty' ? ['bnpTest', 'init'] : ['bnpTest', 'init', 'apply']);
            assert.equal(doc.formAttrs.join(' '), kind + (kind === 'dialog' ? ' resize' : ''));
            if (template === 'applyClose') {
                assert.deepEqual([...walkGadgets(doc.nodes)].map(x => x.node.gadget.name), ['bnApply', 'bnClose']);
                assert.deepEqual(doc.callbackAssigns.map(c => [c.gadget, c.method]), [['bnApply', 'init'], ['bnClose', 'init']]);
            }
        }
    }
    assert.equal(formFileName('bnpMyForm'), 'bnpmyform.pmlfrm');
    assert.equal(validateFormName('bnpOk_1'), null);
    assert.ok(validateFormName('!!bnpX'));
    assert.ok(validateFormName('1bnp'));
    assert.ok(validateFormName('cdForm'));
    assert.ok(formNameWarning('myForm', 'bnp'));
    assert.equal(formNameWarning('bnpForm', 'bnp'), null);
    assert.equal(formNameWarning('myForm', ''), null);
});

test('новая форма: первый гаджет — перед exit setup, после formTitle/initCall; двойной щелчок — callback в .init()', () => {
    const text = newFormText({ name: 'bnpNew', kind: 'dialog', resize: false, title: 'Новая', developer: 'Тест', date: '2026-10-08', template: 'empty' });
    const a = run(text, { op: 'add', type: 'button', parentLine: null, x: 0, y: 0, mode: 'rel' });
    assert.ok(a.text.includes('    !this.initCall  = |!this.init()|\r\n    button .button1 |Кнопка| at x0 y0 wid 10\r\n\r\nexit'), a.text);
    const doc = parseForm(a.text);
    const b = [...walkGadgets(doc.nodes)][0].node;
    const c = run(a.text, { op: 'callback', line: b.line, placement: 'init' });
    assert.ok(c.text.includes('define method .init()\r\n    !this.button1.callback = |!this.button1Callback()|\r\nendmethod'), c.text);
    assert.ok(c.text.includes('define method .button1Callback()\r\nendmethod'), c.text);
});

test('панель элементов: все типы добавляются и разбираются обратно (синтаксис — Справочник PML 12.1, разд. 2.5)', () => {
    const types = ['button', 'frame', 'tabset', 'list', 'option', 'textpane', 'text', 'toggle', 'radiogroup', 'paragraph',
        'combo', 'numericinput', 'slider', 'container', 'line', 'selector'] as const;
    let text = newFormText({ name: 'bnpAll', kind: 'dialog', resize: false, title: 'Все', developer: 'Тест', date: '2026-10-08', template: 'empty' });
    for (const type of types) {
        const r = execute(text, { op: 'add', type, parentLine: null, x: 0, y: 0, mode: 'rel' });
        assert.equal(r.error, undefined, type);
        text = printLines(applyEdits(parseForm(text).lines, r.edits));
    }
    // rtoggle — только во frame
    assert.match(execute(text, { op: 'add', type: 'rtoggle', parentLine: null, x: 0, y: 0, mode: 'abs' }).error!, /только внутри frame/);
    const fr = [...walkGadgets(parseForm(text).nodes)].find(x => x.node.gadget.name === 'frame1')!.node;
    text = printLines(applyEdits(parseForm(text).lines, execute(text, { op: 'add', type: 'rtoggle', parentLine: fr.line, x: 0, y: 0, mode: 'abs' }).edits));

    const doc = parseForm(text);
    assert.deepEqual(doc.problems, []);
    const g = new Map([...walkGadgets(doc.nodes)].map(x => [x.node.gadget.name, x.node.gadget]));
    const expect: [string, string][] = [['button1', 'button'], ['frame1', 'frame'], ['tabset1', 'frame'], ['list1', 'list'], ['option1', 'option'],
        ['textpane1', 'textpane'], ['text1', 'text'], ['toggle1', 'toggle'], ['radio1', 'frame'], ['radio1Opt1', 'rtoggle'], ['radio1Opt2', 'rtoggle'],
        ['para1', 'paragraph'], ['combo1', 'combo'], ['numeric1', 'numericinput'], ['slider1', 'slider'], ['net1', 'container'],
        ['line1', 'line'], ['selector1', 'selector'], ['rtoggle1', 'rtoggle']];
    for (const [name, type] of expect) assert.equal(g.get(name)?.type, type, name);
    // распознано без лишних хвостов (кроме слов-параметров, которые дизайнер не моделирует)
    const allowedExtras = /^(is|string|range|step|val|ndp|0|1|50|100|pmlnetcontrol|''|database|auto|horiz)$/i;
    for (const [name] of expect) for (const e of g.get(name)!.extras) assert.match(e, allowedExtras, `${name}: ${e}`);
    assert.equal(g.get('para1')!.text, 'Надпись');
    assert.equal(g.get('radio1Opt1')!.tag, 'Вариант 1');
    // раскладка всех без NaN
    for (const l of layoutForm(doc).gadgets) assert.ok([l.box.x, l.box.y, l.box.w, l.box.h].every(Number.isFinite), l.name);
});

test('порядок частей по графам 12.1: multiple после at, linklabel после имени, wid у text до is, ok после размера', () => {
    const src = ['setup form !!f', 'list .l |L| at x0 y0 wid 20 hei 5', 'button .b |B| at x0 y6 ok', 'text .t |T| at x0 y8 is REAL',
        'para .p at x0 y10 wid 10', 'exit'].join('\r\n');
    const doc = parseForm(src);
    const n = (name: string) => [...walkGadgets(doc.nodes)].find(x => x.node.gadget.name === name)!.node;
    const L = applyEdits(doc.lines, [
        setFlag(n('l'), 'multiple', true), setFlag(n('b'), 'linklabel', true), setSize(n('b'), 'width', { mode: 'abs', value: 8, raw: '' }),
        setSize(n('t'), 'width', { mode: 'abs', value: 10, raw: '' }),
    ]);
    assert.equal(L[1].text, 'list .l |L| at x0 y0 multiple wid 20 hei 5');
    assert.equal(L[2].text, 'button .b linklabel |B| at x0 y6 wid 8 ok');
    assert.equal(L[3].text, 'text .t |T| at x0 y8 wid 10 is REAL');
    const p = execute(src, { op: 'setProp', line: 4, prop: 'text', value: 'Надпись' });
    assert.equal(applyEdits(doc.lines, p.edits)[4].text, 'para .p at x0 y10 text |Надпись| wid 10');
});

/** Форма из шаблона «Применить/Закрыть» + button1 с callback по двойному щелчку (в .init(), B5). */
function cbForm(): { text: string; line: (name: string) => number } {
    let text = newFormText({ name: 'bnpCb', kind: 'dialog', resize: false, title: 'Cb', developer: 'Тест', date: '2026-10-08', template: 'applyClose' });
    const step = (req: Parameters<typeof execute>[1]) => { const r = execute(text, req); assert.equal(r.error, undefined); text = printLines(applyEdits(parseForm(text).lines, r.edits)); };
    step({ op: 'add', type: 'button', parentLine: null, x: 0, y: 3, mode: 'abs' });
    const lineOf = (name: string) => [...walkGadgets(parseForm(text).nodes)].find(x => x.node.gadget.name === name)!.node.line;
    step({ op: 'callback', line: lineOf('button1'), placement: 'init' });
    return { text, line: lineOf };
}
const setCb = (text: string, line: number, value: string, force = false) => {
    const r = execute(text, { op: 'setProp', line, prop: 'callback', value, force });
    return { r, text: printLines(applyEdits(parseForm(text).lines, r.edits)) };
};

test('динамический callback: новое имя, метода нет → метод переименован (define, -- Method:, вызов в .init())', () => {
    const f = cbForm();
    assert.ok(f.text.includes('define method .button1Callback()'));
    const a = setCb(f.text, f.line('button1'), '!this.doSomething()');
    assert.equal(a.r.error, undefined);
    assert.ok(!/button1Callback/.test(a.text), a.text);
    assert.ok(a.text.includes('-- Method:      doSomething'));
    assert.ok(a.text.includes('define method .doSomething()'));
    assert.ok(a.text.includes('    !this.button1.callback = |!this.doSomething()|'));
    assert.deepEqual(parseForm(a.text).problems, []);
});

test('динамический callback: метод уже есть → callback на него, старая заглушка удалена вместе с блоком описания', () => {
    const f = cbForm();
    const a = setCb(f.text, f.line('button1'), '!this.apply()');
    assert.equal(a.r.error, undefined);
    assert.ok(!/button1Callback/.test(a.text), a.text);
    assert.ok(a.text.includes('    !this.button1.callback = |!this.apply()|'));
    assert.equal((a.text.match(/define method \.apply\(\)/g) ?? []).length, 1);
    assert.match(a.r.notice ?? '', /button1Callback удалён/);
    // файл заканчивается методом apply без «висящего» блока описания
    assert.ok(/define method \.apply\(\)\r\nendmethod\r\n$/.test(a.text) || /define method \.apply\(\)\r\nendmethod$/.test(a.text), a.text.slice(-200));
});

test('динамический callback: старый метод с кодом — подтверждение; вызывается ещё где-то — не удаляется', () => {
    const f = cbForm();
    // в старый метод — код
    const withBody = f.text.replace('define method .button1Callback()\r\nendmethod', 'define method .button1Callback()\r\n    !a = 1\r\nendmethod');
    const q = execute(withBody, { op: 'setProp', line: f.line('button1'), prop: 'callback', value: '!this.apply()' });
    assert.match(q.confirm ?? '', /содержит код/);
    const y = setCb(withBody, f.line('button1'), '!this.apply()', true);
    assert.ok(!/button1Callback/.test(y.text));
    // старый метод вызывается из apply → не удалять
    const called = f.text.replace('define method .apply()\r\nendmethod', 'define method .apply()\r\n    !this.button1Callback()\r\nendmethod');
    const n = setCb(called, f.line('button1'), '!this.bnClose_x()');   // нового нет → переименование, вызов в apply тоже
    assert.ok(n.text.includes('    !this.bnClose_x()\r\nendmethod'), n.text);
    assert.match(n.r.notice ?? '', /обновлены и другие вызовы/);
    const m = setCb(called, f.line('button1'), '!this.apply()');      // новый есть, но старый вызывается → не удалять
    assert.ok(m.text.includes('define method .button1Callback()'));
    assert.match(m.r.notice ?? '', /не удалён/);
});

test('динамический callback: в строке гаджета; новое имя без старого метода → заглушка', () => {
    const src = ['setup form !!f', 'button .b |B| at x0 y0 callback |!this.bClick()| wid 8', 'button .c |C| at x0 y2', 'exit', '',
        'define method .bClick()', 'endmethod'].join('\r\n');
    const a = setCb(src, 1, '!this.onB()');
    assert.ok(a.text.includes('button .b |B| at x0 y0 callback |!this.onB()| wid 8'), a.text);
    assert.ok(a.text.includes('define method .onB()') && !a.text.includes('bClick'));
    const b = setCb(src, 2, '!this.onC()');
    assert.ok(b.text.includes('button .c |C| at x0 y2 callback |!this.onC()|'), b.text);
    assert.ok(b.text.includes('define method .onC()\r\nendmethod'), b.text);
    // имя занято гаджетом
    assert.match(execute(src, { op: 'setProp', line: 1, prop: 'callback', value: '!this.c()' }).error ?? '', /занято/);
});

test('перемещение не двигает привязанные гаджеты (как WinForms): frame1 от toggle2 остаётся на месте', () => {
    const src = ['setup form !!f dialog', '    toggle .toggle1 |Флажок| at x0 y0', '    toggle .toggle2 |Флажок| at xmin .toggle1 ymax .toggle1 + 1',
        '    frame .frame1 |Рамка| at xmin .toggle2 ymax .toggle2 + 1 wid 20 hei 4', '        button .b |B| at x0 y0', '    exit',
        '    path down', '    button .c |C|', '    button .d |D| at xmin .toggle2 + 2 ymax .c', 'exit'].join('\r\n');
    const pos = (t: string) => new Map(layoutForm(parseForm(t)).gadgets.map(g => [g.name, `${g.box.x.toFixed(2)},${g.box.y.toFixed(2)}`]));
    const before = pos(src);
    const a = run(src, { op: 'move', line: 2, x: 0, y: 10, mode: 'keep', defaultMode: 'rel' });
    const after = pos(a.text);
    assert.notEqual(after.get('toggle2'), before.get('toggle2'));
    for (const n of ['toggle1', 'frame1', 'b', 'c', 'd']) assert.equal(after.get(n), before.get(n), n);
    assert.ok(a.text.includes('frame .frame1 |Рамка| at xmin .toggle2 y4 wid 20 hei 4'), a.text);   // X — ссылка, Y — абс.
    assert.match(a.r.notice ?? '', /оставлены на месте.*\.frame1/);
    // сдвиг вправо: у .d ссылка xmin .toggle2 сохраняется с новым смещением
    const b = run(src, { op: 'move', line: 2, x: 5, y: 2, mode: 'keep', defaultMode: 'rel' });
    const afterB = pos(b.text);
    for (const n of ['toggle1', 'frame1', 'b', 'c', 'd']) assert.equal(afterB.get(n), before.get(n), n);
    assert.ok(b.text.includes('button .d |D| at xmin .toggle2 - 3 ymax .c'), b.text);
    // размер: увеличение frame1 не двигает .c и .d
    const fr = run(src, { op: 'resize', line: 3, w: 30, h: 8 });
    const afterR = pos(fr.text);
    for (const n of ['c', 'd']) assert.equal(afterR.get(n), before.get(n), n);
});

test('привязка к гаджету ниже по тексту: выравнивание, но абсолютная координата; поле Y такую ссылку не принимает', () => {
    // .t стоит в тексте раньше .l (как .checkBolt и .speclist в pipebelnipiform)
    const src = ['setup form !!f', 'button .b |B| at x0 y0', 'toggle .t |T| at xmax .b + 2 ymin .b', 'list .l |L| at xmin .b ymax .b + 1 wid 20 hei 5', 'exit'].join('\r\n');
    const L = layoutForm(parseForm(src));
    const l = L.gadgets.find(g => g.name === 'l')!, t = L.gadgets.find(g => g.name === 't')!;
    const y = l.local.y + l.box.h + 0.25;
    const a = run(src, { op: 'move', line: 2, x: t.local.x, y, mode: 'keep', snapY: { ref: 'l', edge: 'max' } });
    const line = a.text.split('\r\n')[2];
    assert.ok(!/\.l\b/.test(line), line);                         // ссылки на .l нет
    const t2 = layoutForm(parseForm(a.text)).gadgets.find(g => g.name === 't')!;
    assert.ok(!t2.approx, t2.approxWhy);
    assert.ok(Math.abs(t2.box.y - (l.box.y + l.box.h + 0.25)) < 0.02);   // ровно под списком
    // привязка к гаджету выше — ссылкой
    const b = run(src, { op: 'move', line: 3, x: l.local.x, y: t.local.y + t.box.h + 0.5, mode: 'keep', snapY: { ref: 't', edge: 'max' } });
    assert.ok(b.text.split('\r\n')[3].includes('ymax .t + 0.5'), b.text);
    // поле Y
    assert.match(execute(src, { op: 'setProp', line: 2, prop: 'y', value: 'ymax .l + 0.25' }).error ?? '', /ниже по тексту/);
    assert.match(execute(src, { op: 'setProp', line: 2, prop: 'y', value: 'ymax .nope' }).error ?? '', /не найден/);
});
