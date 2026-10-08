// Операции дизайнера: запрос с холста → точечные правки текста (без зависимости от VS Code).
// Расширение применяет правки через WorkspaceEdit, поэтому работают undo/redo VS Code.

import { FormDocument, GadgetNode, parseForm, printLines, walkGadgets } from './form';
import { Coord, SizeSpec } from './gadget';
import { FormLayout, LaidGadget, layoutForm, widthSpecFromBox, heightSpecFromBox } from './layout';
import {
    Edit, CodeStyle, detectStyle, setPosition, setSize, setTag, setCallback, setTooltip, setAnchor, setDock, setFlag,
    renameGadget, deleteGadget, findReferences, newGadgetLines, newPageLines, insertionPoint, indentUnitOf, uniqueName,
    usedNames, addMethodStub, setCallbackInInit, parseCoordText, NewGadgetType, newGadgetBase, setText,
    callbackMethod, methodCalls, renameMethod, methodHasBody, deleteMethod, applyEdits, indentOf, formatAt,
} from './edits';

/** Режим записи позиции: abs — `at x5 y2`; rel — от края соседнего гаджета; keep — как сейчас. */
export type PosMode = 'abs' | 'rel' | 'keep';

/** Привязка при перетаскивании к краю гаджета (из направляющих на холсте). */
export interface Snap { ref: string; edge: 'min' | 'max' }

export type Request =
    | { op: 'move'; line: number; x: number; y: number; mode: PosMode; snapX?: Snap; snapY?: Snap; defaultMode?: 'abs' | 'rel' }
    | { op: 'resize'; line: number; w?: number; h?: number }
    /** Сдвиг стрелками: позиция = текущая (по свежей раскладке) + dx/dy. */
    | { op: 'nudge'; line: number; dx: number; dy: number; defaultMode?: 'abs' | 'rel' }
    | { op: 'setProp'; line: number; prop: string; value: string; force?: boolean }
    | { op: 'setMode'; line: number; mode: 'abs' | 'rel' }
    | { op: 'add'; type: NewGadgetType; parentLine: number | null; x: number; y: number; mode: 'abs' | 'rel' }
    | { op: 'addPage'; line: number }
    | { op: 'delete'; line: number; force?: boolean }
    | { op: 'callback'; line: number; placement: 'init' | 'gadget' }
    /** Перенос в другой контейнер: parentLine — строка frame (страницы tabset) или null (форма); x, y — в его сетке. */
    | { op: 'reparent'; line: number; parentLine: number | null; x: number; y: number; defaultMode?: 'abs' | 'rel'; force?: boolean };

export interface Result {
    edits: Edit[];
    /** Нужен ответ пользователя (удаление гаджета, на который есть ссылки). */
    confirm?: string;
    /** После применения показать метод (двойной щелчок по гаджету). */
    revealMethod?: string;
    /** После применения выделить гаджет с этим именем. */
    select?: string;
    /** Сообщение пользователю (ошибка ввода и т. п.). */
    error?: string;
    /** Информация после успешной операции (напр. о ссылках на перенесённый гаджет). */
    notice?: string;
}

// округление до 0.01: шаг сетки по Y — 0.25
const r1 = (v: number) => Math.round(v * 100) / 100;

export function execute(text: string, req: Request, styleOverride?: CodeStyle): Result {
    const doc = parseForm(text);
    const layout = layoutForm(doc);
    const st = styleOverride ?? detectStyle(doc);
    const node = 'line' in req ? findNode(doc, req.line) : undefined;
    const laid = node ? layout.gadgets.find(g => g.line === node.line) : undefined;
    const fail = (error: string): Result => ({ edits: [], error });

    if ('line' in req && !node) return fail('Гаджет не найден — обновите дизайнер');
    if (node?.readOnly && req.op !== 'callback') return fail(node.readOnly);
    // гаджет есть в тексте, но не раскладывается на холсте (напр. строка внутри view…exit) — двигать нечего
    if (node && !laid && ['move', 'nudge', 'resize', 'setMode', 'reparent'].includes(req.op)) return fail('Гаджет не отображается на холсте — правка только в коде');

    switch (req.op) {
        case 'move': {
            if (laid!.page) return fail('Страница tabset перемещается вместе с tabset');
            const g = node!.gadget;
            // ось без AT (автоматическая расстановка) — по переключателю «Отн./Абс.» на панели
            const modeFor = (c?: Coord): PosMode => (!c && req.mode === 'keep' ? req.defaultMode ?? 'rel' : req.mode);
            const x = coordFor('x', r1(req.x), laid!, g.at?.x, modeFor(g.at?.x), req.snapX, layout);
            const y = coordFor('y', r1(req.y), laid!, g.at?.y, modeFor(g.at?.y), req.snapY, layout);
            if ((g.at?.x && !g.at.x.exact) || (g.at?.y && !g.at.y.exact)) return fail('Позиция задана сложным выражением — правьте в коде');
            return keepOthersInPlace(text, doc, layout, node!, [setPosition(node!, x, y, st)], st);
        }

        case 'nudge':
            return execute(text, { op: 'move', line: req.line, x: laid!.local.x + req.dx, y: laid!.local.y + req.dy, mode: 'keep', defaultMode: req.defaultMode }, styleOverride);

        case 'resize': {
            const g = node!.gadget, edits: Edit[] = [];
            if (req.w !== undefined) edits.push(setSize(node!, 'width', { mode: 'abs', value: widthSpecFromBox(g, req.w, layout.varChars), raw: '' }));
            if (req.h !== undefined) edits.push(setSize(node!, 'height', { mode: 'abs', value: heightSpecFromBox(g, req.h), raw: '' }));
            return keepOthersInPlace(text, doc, layout, node!, edits, st);
        }

        case 'setMode': {
            const g = node!.gadget;
            if ((g.at?.x && !g.at.x.exact) || (g.at?.y && !g.at.y.exact)) return fail('Позиция задана сложным выражением — правьте в коде');
            const x = coordFor('x', laid!.local.x, laid!, g.at?.x, req.mode, undefined, layout);
            const y = coordFor('y', laid!.local.y, laid!, g.at?.y, req.mode, undefined, layout);
            return { edits: [setPosition(node!, x, y, st)] };
        }

        case 'setProp': return setProp(doc, node!, req.prop, req.value, st, req.force);

        case 'add': {
            const parent = req.parentLine === null ? undefined : findNode(doc, req.parentLine);
            if (parent && parent.gadget.type !== 'frame') return fail('Гаджеты добавляются в форму или frame');
            if (parent?.gadget.flags.includes('tabset')) return fail('В tabset добавляются только страницы — выберите страницу');
            // Справочник 12.1, RTOGGLE: «allowed only within FRAMES»
            if (req.type === 'rtoggle' && !parent) return fail('rtoggle допускается только внутри frame — бросьте его в рамку (или возьмите «Группу переключателей»)');
            const ip = insertionPoint(doc, parent);
            const unit = indentUnitOf(doc);
            const name = uniqueName(doc, newGadgetBase(req.type));
            // соседи контейнера в раскладке — последний станет «предыдущим» для нового гаджета
            const siblings = layout.gadgets.filter(g => g.parent === (parent?.gadget.name ?? '') && !g.page);
            const prev = siblings[siblings.length - 1];
            const nc = newCoords(r1(req.x), r1(req.y), req.mode, prev);
            const at = formatAt(nc.x, nc.y, st);
            // вложенные имена: страница tabset, переключатели группы
            const sub = req.type === 'tabset' ? uniqueName(doc, `${name}Page`)
                : req.type === 'radiogroup' ? freeNames(doc, `${name}Opt`, 2).join(',') : undefined;
            const lines = newGadgetLines(req.type, name, at, unit, sub)
                .map(l => ip.indent + l);
            return { edits: [{ line: ip.line, deleteCount: 0, insert: lines }], select: name };
        }

        case 'addPage': {
            const ts = node!.gadget.flags.includes('tabset') ? node! : undefined;
            if (!ts) return fail('Страницы добавляются в tabset');
            const pages = (ts.children ?? []).filter(n => n.kind === 'gadget' && n.gadget.type === 'frame').length;
            const ip = insertionPoint(doc, ts);
            const name = uniqueName(doc, `${ts.gadget.name}Page`);
            const indent = ip.indent;
            return { edits: [{ line: ip.line, deleteCount: 0, insert: newPageLines(name, `Страница ${pages + 1}`).map(l => indent + l) }], select: name };
        }

        case 'delete': {
            const refs = findReferences(doc, node!);
            if (refs.length && !req.force) {
                const list = refs.slice(0, 8).map(i => `${i + 1}: ${doc.lines[i].text.trim().slice(0, 70)}`).join('\n');
                return { edits: [], confirm: `На .${node!.gadget.name} ссылаются ${refs.length} строк(и):\n${list}${refs.length > 8 ? '\n…' : ''}\n\nУдалить гаджет? Ссылки останутся в коде.` };
            }
            const del = deleteGadget(node!);
            return { edits: [{ ...del, deleteCount: del.deleteCount + (node!.continuation ?? 0), insert: closePrevRgroup(doc, node!) }] };
        }

        case 'reparent': return reparent(doc, layout, node!, laid!, req, st);

        case 'callback': {
            const g = node!.gadget;
            const existing = g.callback ?? doc.callbackAssigns.find(c => c.gadget.toLowerCase() === g.name.toLowerCase())?.value;
            const target = existing && /!this\.(\w+)\s*\(/i.exec(existing);
            if (target && doc.methods.some(m => m.name.toLowerCase() === target[1].toLowerCase())) return { edits: [], revealMethod: target[1] };
            if (existing && !target) return fail(`Callback уже задан: ${existing}`);
            if (node!.readOnly) return fail(node!.readOnly);
            const method = target ? target[1] : uniqueMethodName(doc, `${g.name}Callback`);
            const value = `!this.${method}()`;
            const edits: Edit[] = [];
            if (!existing) {
                const inInit = req.placement === 'init' ? setCallbackInInit(doc, g.name, value) : undefined;
                edits.push(inInit ?? setCallback(node!, value));
            }
            const stub = addMethodStub(doc, method, [], `Callback гаджета .${g.name}`);
            if (stub) edits.push(stub);
            return { edits, revealMethod: method };
        }
    }
}

/** rgroup, закрытый неявно (строки add без своего exit). */
function isImplicitRgroup(doc: FormDocument, n: GadgetNode): boolean {
    return n.gadget.type === 'rgroup' && !/^\s*exit\b/i.test(doc.lines[n.endLine ?? n.line].text);
}

/**
 * Удаляемый/переносимый гаджет мог неявно закрывать стоящий перед ним rgroup (строки add без exit).
 * Без него следующий exit контейнера закрыл бы rgroup — поэтому на месте удалённых строк ставится явный exit rgroup.
 */
function closePrevRgroup(doc: FormDocument, node: GadgetNode): string[] {
    const siblings = siblingsOf(doc, node);
    const i = siblings.indexOf(node);
    const prev = i > 0 ? siblings[i - 1] : undefined;
    return prev && isImplicitRgroup(doc, prev) ? [indentOf(doc.lines[prev.line]) + 'exit'] : [];
}

/** Гаджеты того же контейнера (в порядке текста). */
function siblingsOf(doc: FormDocument, node: GadgetNode): GadgetNode[] {
    for (const { node: n, parent } of walkGadgets(doc.nodes)) {
        if (n !== node) continue;
        const list = parent ? parent.children ?? [] : doc.nodes;
        return list.filter((c): c is GadgetNode => c.kind === 'gadget');
    }
    return [];
}

function findNode(doc: FormDocument, line: number): GadgetNode | undefined {
    for (const { node } of walkGadgets(doc.nodes)) if (node.line === line) return node;
    return undefined;
}

/**
 * Как в WinForms: перемещение/размер одного гаджета не двигает остальные. В PML гаджеты, привязанные к нему
 * (`ymax .g + 1`, безымянные xmin/ymax от предыдущего, авторасстановка path), поехали бы следом —
 * после правки пересчитываем раскладку и каждому сдвинувшемуся «за компанию» возвращаем прежнее место:
 * относительная ось — новое смещение (ссылка сохраняется; если она стала бы «задом наперёд» — абсолютная),
 * абсолютная/авто — абсолютная. По одному гаджету в порядке текста с пересчётом (цепочки привязок).
 * Содержимое самого гаджета (frame) едет вместе с ним — его не трогаем.
 */
function keepOthersInPlace(text: string, doc: FormDocument, layout: FormLayout, node: GadgetNode, edits: Edit[], st: CodeStyle): Result {
    const own = new Set<number>();
    for (let i = node.line; i <= (node.endLine ?? node.line) + (node.continuation ?? 0); i++) own.add(i);
    const before = new Map(layout.gadgets.map(g => [g.line, g.box]));
    const fixedNames: string[] = [];
    const skipped: string[] = [];
    const done = new Set<number>(own);
    const EPS = 0.01;
    let cur = printLines(applyEdits(doc.lines, edits));
    for (let iter = 0; iter < 500; iter++) {
        const d = parseForm(cur);
        const L = layoutForm(d);
        const moved = L.gadgets.find(g => {
            const b = before.get(g.line);
            return b && !done.has(g.line) && (Math.abs(b.x - g.box.x) > EPS || Math.abs(b.y - g.box.y) > EPS);
        });
        if (!moved) break;
        done.add(moved.line);
        const n = findNode(d, moved.line);
        const at = n?.gadget.at;
        if (!n || n.readOnly || n.conditional || (at?.x && !at.x.exact) || (at?.y && !at.y.exact)) { if (moved.name) skipped.push('.' + moved.name); continue; }
        const b = before.get(moved.line)!;
        const fix = (axis: 'x' | 'y', c: Coord | undefined): Coord | undefined => {
            const was = axis === 'x' ? b.x : b.y, now = axis === 'x' ? moved.box.x : moved.box.y;
            if (Math.abs(was - now) <= EPS) return c;                       // ось не сдвинулась — как есть
            const want = r1(was - (axis === 'x' ? moved.origin.x : moved.origin.y));
            const base = { axis, start: 0, end: 0, exact: true } as const;
            if (c && c.mode === 'rel') {
                const v = r1(c.value + (was - now));
                // ссылка «задом наперёд» (от края max с отрицательным смещением) — понятнее абсолютная
                if (!(c.edge === 'max' && v < -EPS)) return { ...c, value: v };
            }
            return { ...base, mode: 'abs', value: want };
        };
        const e = setPosition(n, fix('x', at?.x), fix('y', at?.y), st);
        edits.push(e);                          // строка n не менялась раньше → смещения в ней совпадают с исходным текстом
        cur = printLines(applyEdits(d.lines, [e]));
        if (moved.name) fixedNames.push('.' + moved.name);
    }
    const notes: string[] = [];
    if (fixedNames.length) notes.push(`оставлены на месте (были привязаны к .${node.gadget.name}): ${fixedNames.join(', ')}`);
    if (skipped.length) notes.push(`сдвинулись вместе с ним (позиция в коде сложная/условная): ${skipped.join(', ')}`);
    return { edits, notice: notes.length ? notes.join('; ') : undefined };
}

/** count свободных имён base1, base2, … (не заняты гаджетами, member, методами). */
function freeNames(doc: FormDocument, base: string, count: number): string[] {
    const used = usedNames(doc);
    const out: string[] = [];
    for (let i = 1; out.length < count; i++) if (!used.has(`${base}${i}`.toLowerCase())) out.push(`${base}${i}`);
    return out;
}

function uniqueMethodName(doc: FormDocument, base: string): string {
    const used = usedNames(doc);
    if (!used.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

/**
 * Координата оси для новой позиции v (в сетке контейнера).
 * keep: относительная — меняется только смещение (ссылка и край сохраняются); абсолютная — число;
 *       не заданная — по умолчанию относительная от предыдущего гаджета.
 */
function coordFor(axis: 'x' | 'y', v: number, laid: LaidGadget, cur: Coord | undefined, mode: PosMode,
    snap: Snap | undefined, layout: FormLayout): Coord {
    const base = { axis, start: 0, end: 0, exact: true } as const;
    if (snap) {
        const ref = layout.gadgets.find(g => g.name.toLowerCase() === snap.ref.toLowerCase());
        // ссылаться можно только на гаджет, определённый ВЫШЕ по тексту: иначе E3D (и раскладка) его не найдёт —
        // выравнивание сохраняем, но ось пишем абсолютной (pipebelnipiform: .checkBolt → ymax .speclist, 2026-10-08)
        if (ref && ref.line > laid.line) return { ...base, mode: 'abs', value: v };
        if (ref) {
            const edgePos = edgeLocal(axis, ref, snap.edge, laid);
            return { ...base, mode: 'rel', edge: snap.edge, ref: ref.name, value: r1(v - edgePos) };
        }
    }
    const old = axis === 'x' ? laid.local.x : laid.local.y;
    if (mode === 'abs') return { ...base, mode: 'abs', value: v };
    if (cur && cur.mode === 'rel' && (mode === 'keep' || mode === 'rel')) {
        // смещение линейно входит в координату: новое = старое + сдвиг
        return { ...cur, value: r1(cur.value + (v - old)) };
    }
    if (cur && cur.mode === 'abs' && mode === 'keep') return { ...base, mode: 'abs', value: v };
    // rel из abs/auto: от ближайшего края предыдущего гаджета (или abs, если предыдущего нет)
    const prev = laid.prev ? layout.gadgets.find(g => g.name === laid.prev) : undefined;
    if (!prev) return { ...base, mode: 'abs', value: v };
    const eMin = edgeLocal(axis, prev, 'min', laid), eMax = edgeLocal(axis, prev, 'max', laid);
    const edge = Math.abs(v - eMin) <= Math.abs(v - eMax) ? 'min' : 'max';
    return { ...base, mode: 'rel', edge, ref: prev.name, value: r1(v - (edge === 'min' ? eMin : eMax)) };
}

/** Край гаджета ref в сетке контейнера гаджета laid. */
function edgeLocal(axis: 'x' | 'y', ref: LaidGadget, edge: 'min' | 'max', laid: LaidGadget): number {
    const lo = axis === 'x' ? ref.box.x - laid.origin.x : ref.box.y - laid.origin.y;
    const size = axis === 'x' ? ref.box.w : ref.box.h;
    return edge === 'min' ? lo : lo + size;
}

/**
 * Координаты гаджета, встающего в конец контейнера (его «предыдущий» — prev).
 * rel — от ближайшего края prev, смещение с шагом сетки (X 0.5, Y 0.25); без prev или abs — числа.
 */
function newCoords(x: number, y: number, mode: 'abs' | 'rel', prev: LaidGadget | undefined): { x: Coord; y: Coord } {
    const one = (axis: 'x' | 'y', v: number): Coord => {
        const base = { axis, start: 0, end: 0, exact: true } as const;
        if (mode === 'abs' || !prev) return { ...base, mode: 'abs', value: r1(v) };
        const lo = axis === 'x' ? prev.local.x : prev.local.y;
        const hi = lo + (axis === 'x' ? prev.box.w : prev.box.h);
        const edge = Math.abs(v - lo) <= Math.abs(v - hi) ? 'min' : 'max';
        const step = axis === 'x' ? 0.5 : 0.25;
        const off = r1(Math.round((v - (edge === 'min' ? lo : hi)) / step) * step);
        return { ...base, mode: 'rel', edge, ref: prev.name, value: off };
    };
    return { x: one('x', x), y: one('y', y) };
}

/**
 * Перенос гаджета (с содержимым, если это frame) в конец другого контейнера.
 * Строки вырезаются и вставляются с пересчётом отступа; AT переписывается в сетке нового контейнера
 * в том же режиме (rel — от последнего гаджета нового контейнера, abs — числа; без AT — по переключателю панели).
 */
function reparent(doc: FormDocument, layout: FormLayout, node: GadgetNode, laid: LaidGadget,
    req: Extract<Request, { op: 'reparent' }>, st: CodeStyle): Result {
    const fail = (error: string): Result => ({ edits: [], error });
    if (laid.page) return fail('Страница tabset переносится только вместе с tabset');
    if (node.conditional) return fail('Гаджет внутри if/do в setup (создаётся по условию) — переносите в коде');
    const target = req.parentLine === null ? undefined : findNode(doc, req.parentLine);
    if (req.parentLine !== null && !target) return fail('Контейнер не найден — обновите дизайнер');
    if (target && target.gadget.type !== 'frame') return fail('Переносить можно в форму или frame');
    if (target?.gadget.flags.includes('tabset')) return fail('В tabset — только страницы: перенесите гаджет на страницу');
    if (target?.readOnly) return fail(target.readOnly);
    const last = (node.endLine ?? node.line) + (node.continuation ?? 0);
    if (target && target.line >= node.line && target.line <= last) return fail('Нельзя перенести frame внутрь самого себя');
    const targetName = target?.gadget.name ?? '';
    if (targetName.toLowerCase() === laid.parent.toLowerCase()) return fail('Гаджет уже в этом контейнере');

    // режим записи: как у гаджета сейчас (любая относительная ось → rel), без AT — по переключателю
    const g = node.gadget;
    if ((g.at?.x && !g.at.x.exact) || (g.at?.y && !g.at.y.exact)) return fail('Позиция задана сложным выражением — правьте в коде');
    const mode: 'abs' | 'rel' = !g.at ? req.defaultMode ?? 'rel'
        : (g.at.x?.mode === 'rel' || g.at.y?.mode === 'rel') ? 'rel' : 'abs';
    const prevs = layout.gadgets.filter(x => x.parent.toLowerCase() === targetName.toLowerCase() && !x.page && x.line !== node.line);
    const prev = prevs[prevs.length - 1];
    const nc = newCoords(r1(req.x), r1(req.y), mode, prev);

    // строки гаджета: первая — с новым AT, все — с отступом нового контейнера
    const moved = doc.lines.slice(node.line, last + 1).map(l => ({ ...l }));
    const first = applyEdits([doc.lines[node.line]], [{ ...setPosition(node, nc.x, nc.y, st), line: 0 }])[0];
    moved[0] = first;
    const ip = insertionPoint(doc, target);
    const oldIndent = indentOf(doc.lines[node.line]);
    const text = moved.map(l => (l.text.startsWith(oldIndent) ? ip.indent + l.text.slice(oldIndent.length) : l.text));
    // rgroup без своего exit: следующий за ним exit контейнера закрыл бы rgroup → закрываем явно
    if (isImplicitRgroup(doc, node)) text.push(ip.indent + 'exit');

    // ссылки других гаджетов по имени (AT/размеры в setup). Гаджет, определённый ВЫШЕ нового места и ссылающийся
    // на переносимый, — ссылка вперёд: E3D при загрузке формы его не найдёт → перенос запрещён.
    const notes: string[] = [];
    const end = doc.setupEndLine ?? doc.implicitEnd ?? doc.lines.length;
    const atRefs = findReferences(doc, node).filter(i => i < end && !/^\s*!/.test(doc.lines[i].text));
    const forward = atRefs.filter(i => i < ip.line && (i < node.line || i > last));
    const fixEdits: Edit[] = [];
    if (forward.length) {
        // такие гаджеты можно «отвязать»: позицию (и размер, если он от переносимого) — в абсолютные числа
        const all = [...walkGadgets(doc.nodes)].map(x => x.node);
        const owners = [...new Set(forward.map(i => all.find(n => i >= n.line && i <= n.line + (n.continuation ?? 0))))];
        const refsG = (ref?: string) => !!ref && ref.toLowerCase() === g.name.toLowerCase();
        // строка без гаджета (напр. оператор в setup), «только просмотр» или сложное выражение — автоматически не пересчитать
        const blocked = owners.some(o => !o || o.readOnly || [o.gadget.at?.x, o.gadget.at?.y].some(c => c && !c.exact));
        if (blocked) {
            return fail(`Нельзя перенести .${g.name}: от него позиционируются гаджеты выше по тексту (строки ${forward.map(i => i + 1).join(', ')}), ` +
                'и их позицию нельзя пересчитать автоматически. Правьте в коде.');
        }
        const names = owners.map(o => '.' + o!.gadget.name).join(', ');
        if (!req.force) {
            return {
                edits: [], confirm: `От .${g.name} позиционируются ${names} — после переноса они окажутся выше по тексту ` +
                    `(ссылка вперёд: E3D не загрузит форму).\n\nПеревести их позицию в абсолютную и перенести .${g.name}?`,
            };
        }
        for (const o of owners as GadgetNode[]) {
            const lo = layout.gadgets.find(x => x.line === o.line)!;
            const at = o.gadget.at;
            const absOf = (c: Coord | undefined, v: number): Coord | undefined =>
                c && c.mode === 'rel' && refsG(c.ref) ? { ...c, mode: 'abs', value: r1(v), ref: undefined, edge: undefined, minusSize: false } : c;
            if (at && (refsG(at.x?.ref) || refsG(at.y?.ref))) fixEdits.push(setPosition(o, absOf(at.x, lo.local.x), absOf(at.y, lo.local.y), st));
            const sizeRefs = (s?: SizeSpec) => !!s && ((s.mode === 'same' && refsG(s.ref)) || (s.mode === 'to' && new RegExp(`[._\\s]${g.name}\\b`, 'i').test(s.raw)));
            if (sizeRefs(o.gadget.width)) fixEdits.push(setSize(o, 'width', { mode: 'abs', value: widthSpecFromBox(o.gadget, lo.box.w, layout.varChars), raw: '' }));
            if (sizeRefs(o.gadget.height)) fixEdits.push(setSize(o, 'height', { mode: 'abs', value: heightSpecFromBox(o.gadget, lo.box.h), raw: '' }));
        }
        notes.push(`позиция ${names} переведена в абсолютную`);
    }
    const later = atRefs.filter(i => !forward.includes(i));
    if (later.length) notes.push(`на .${g.name} ссылаются строки ${later.map(i => i + 1).join(', ')} — их позиции теперь считаются от гаджета в другом контейнере`);
    const sibs = layout.gadgets.filter(x => x.parent === laid.parent && !x.page);
    const next = sibs[sibs.indexOf(laid) + 1];
    if (next) {
        const nn = findNode(doc, next.line);
        const unnamed = !nn?.gadget.at || [nn.gadget.at.x, nn.gadget.at.y].some(c => !c || (c.mode === 'rel' && c.ref === ''));
        if (unnamed) notes.push(`.${next.name} расставлен от предыдущего гаджета — его позиция изменится`);
    }
    return {
        edits: [...fixEdits, { line: node.line, deleteCount: last - node.line + 1, insert: closePrevRgroup(doc, node) }, { line: ip.line, deleteCount: 0, insert: text }],
        select: g.name,
        notice: notes.length ? `Перенос .${g.name}: ${notes.join('; ')}.` : undefined,
    };
}

function setProp(doc: FormDocument, node: GadgetNode, prop: string, value: string, st: CodeStyle, force = false): Result {
    const v = value.trim();
    const fail = (error: string): Result => ({ edits: [], error });
    const g = node.gadget;
    switch (prop) {
        case 'tag': return { edits: [setTag(node, value)] };
        case 'text': return { edits: [setText(node, value)] };
        case 'name': {
            if (!/^[A-Za-z]\w*$/.test(v)) return fail('Имя: латинские буквы, цифры, _; начинается с буквы');
            if (v.toLowerCase() !== g.name.toLowerCase() && usedNames(doc).has(v.toLowerCase())) return fail(`Имя .${v} уже занято (гаджет, member или метод)`);
            return { edits: renameGadget(doc, node, v), select: v };
        }
        case 'callback': {
            // где записан callback: в строке гаджета или в коде (`!this.gad.callback = |…|`, правило B5)
            const assign = doc.callbackAssigns.find(c => c.gadget.toLowerCase() === g.name.toLowerCase());
            const inCode = !!assign && g.callback === undefined;
            if (inCode && !v) return fail(`Callback назначен в коде (строка ${assign!.line + 1}) — удалите его там`);
            const setEdit = (): Edit => (inCode ? setCallbackInInit(doc, g.name, v)! : setCallback(node, v || undefined));

            // динамический callback (2026-10-08): `!this.старый()` → `!this.новый()`
            const oldName = callbackMethod(g.callback ?? assign?.value);
            const newName = callbackMethod(v);
            const find = (n?: string) => n ? doc.methods.find(m => m.name.toLowerCase() === n.toLowerCase()) : undefined;
            const oldM = find(oldName), newM = find(newName);
            const cbLine = inCode ? assign!.line : node.line;   // строка, где стоит сам этот callback
            if (oldM && newName && oldName!.toLowerCase() !== newName.toLowerCase()) {
                const others = methodCalls(doc, oldName!).filter(c => c.line !== cbLine);
                if (!newM) {
                    // нового метода нет → переименовать старый (define, блок -- Method:, все вызовы, сам callback)
                    if (usedNames(doc).has(newName.toLowerCase())) return fail(`Имя .${newName} занято гаджетом или member`);
                    return {
                        edits: renameMethod(doc, oldM, newName),
                        notice: others.length ? `Метод .${oldName} переименован в .${newName}; обновлены и другие вызовы (строки ${others.map(c => c.line + 1).join(', ')})` : undefined,
                    };
                }
                // новый метод есть → переключить callback и удалить старый (если больше нигде не вызывается)
                if (others.length) {
                    return { edits: [setEdit()], notice: `Метод .${oldName} не удалён: он вызывается ещё в строках ${others.map(c => c.line + 1).join(', ')}` };
                }
                if (methodHasBody(doc, oldM) && !force) {
                    return { edits: [], confirm: `Callback переключается на существующий метод .${newName}.\n\nСтарый метод .${oldName} содержит код. Удалить его?` };
                }
                return { edits: [setEdit(), deleteMethod(doc, oldM)], notice: `Метод .${oldName} удалён (callback → .${newName})` };
            }
            // метода нового callback ещё нет → заглушка (как при двойном щелчке)
            if (newName && !newM && !(oldName && oldName.toLowerCase() === newName.toLowerCase())) {
                if (usedNames(doc).has(newName.toLowerCase())) return fail(`Имя .${newName} занято гаджетом или member`);
                const stub = addMethodStub(doc, newName, [], `Callback гаджета .${g.name}`);
                return { edits: stub ? [setEdit(), stub] : [setEdit()] };
            }
            return { edits: [setEdit()] };
        }
        case 'tooltip': return { edits: [setTooltip(node, v || undefined)] };
        case 'anchor': return { edits: [setAnchor(node, v || undefined)] };
        case 'dock': return { edits: [setDock(node, v || undefined)] };
        case 'width': case 'height': {
            const kind = prop;
            if (!v) return { edits: [setSize(node, kind, undefined)] };
            const spec: SizeSpec = /^-?\d*\.?\d+$/.test(v) ? { mode: 'abs', value: parseFloat(v), raw: v } : { mode: 'raw', raw: v };
            return { edits: [setSize(node, kind, spec)] };
        }
        case 'x': case 'y': {
            const axis = prop;
            const other = axis === 'x' ? g.at?.y : g.at?.x;
            if (other && !other.exact) return fail('Другая координата задана сложным выражением — правьте в коде');
            const c = v ? parseCoordText(axis, v) : undefined;
            if (v && !c) return fail(`Не удалось разобрать координату: ${v}`);
            // ссылка — только на гаджет выше по тексту (иначе E3D его не найдёт)
            if (c?.mode === 'rel' && c.ref && c.ref.toLowerCase() !== 'form') {
                const target = [...walkGadgets(doc.nodes)].find(x => x.node.gadget.name.toLowerCase() === c.ref!.toLowerCase())?.node;
                if (!target) return fail(`Гаджет .${c.ref} не найден в форме`);
                if (target.line > node.line) return fail(`.${target.gadget.name} определён ниже по тексту (строка ${target.line + 1}) — E3D его не найдёт. Ссылайтесь на гаджет выше или задайте абсолютную координату`);
            }
            return { edits: [setPosition(node, axis === 'x' ? c : other, axis === 'y' ? c : other, st)] };
        }
        case 'multiple': return { edits: [setFlag(node, 'multiple', v === 'true')] };
        case 'linklabel': return { edits: [setFlag(node, 'linklabel', v === 'true')] };
        default: return fail(`Свойство ${prop} не редактируется`);
    }
}
