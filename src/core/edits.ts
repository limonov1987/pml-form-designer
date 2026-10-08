// Точечные правки текста формы. Каждая функция возвращает список LineEdit —
// замену фрагмента [start, end) в строке line. Остальной текст строки не меняется.

import { Coord, Clause, ParsedGadget, SizeSpec, parseGadgetLine } from './gadget';
import { FormDocument, GadgetNode, SourceLine, MethodInfo } from './form';

import { L } from './i18n';
export interface LineEdit {
    line: number;
    start: number;
    end: number;
    newText: string;
}

/** Вставка/удаление целых строк. */
export interface LinesEdit {
    /** Вставить перед строкой line (или удалить count строк начиная с line). */
    line: number;
    deleteCount: number;
    insert: string[];
}

export type Edit = LineEdit | LinesEdit;

const fmtNum = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Стиль записи координат. spaced — как в правилах проекта (B1): `xmin .g ymax .g + 0.25`, `xmax form - size`;
 * compact — `xmin.g ymax.g+0.25` (встречается в LOCAL_LIB). Выбирается по файлу (detectStyle) или настройкой.
 */
export interface CodeStyle { spaced: boolean }
export const DEFAULT_STYLE: CodeStyle = { spaced: true };

/** Стиль файла: преобладают ли записи вида `xmin .gad` / `+ 0.5` (с пробелами). */
export function detectStyle(doc: FormDocument): CodeStyle {
    let spaced = 0, compact = 0;
    const end = doc.setupEndLine ?? doc.implicitEnd ?? doc.lines.length;
    for (let i = doc.setupLine ?? 0; i < end; i++) {
        const t = doc.lines[i].text;
        if (/\b[xy](min|max|cen)\s+\.\w/i.test(t) || /\b[xy](min|max|cen)\b[^|']*?\s[+-]\s\d/i.test(t)) spaced++;
        if (/\b[xy](min|max|cen)\.\w/i.test(t) || /\b[xy](min|max|cen)[.\w]*[+-]\d/i.test(t)) compact++;
    }
    return { spaced: spaced >= compact };
}

const fmtOffset = (v: number, st: CodeStyle) => {
    if (Math.abs(v) < 1e-9) return '';
    const sign = v > 0 ? '+' : '-';
    return st.spaced ? ` ${sign} ${fmtNum(Math.abs(v))}` : `${sign}${fmtNum(Math.abs(v))}`;
};

/** Текст одной координаты: `x0`, `ymax .gad + 0.5` / `ymax.gad+0.5`, `xmax form - size`. */
export function formatCoord(c: Pick<Coord, 'axis' | 'mode' | 'value' | 'edge' | 'ref' | 'minusSize'>, st: CodeStyle = DEFAULT_STYLE): string {
    if (c.mode === 'abs') return `${c.axis}${fmtNum(c.value)}`;
    let s = `${c.axis}${c.edge ?? 'min'}`;
    if (c.ref === 'form') s += ' form';
    else if (c.ref) s += st.spaced ? ` .${c.ref}` : `.${c.ref}`;
    if (c.minusSize) s += st.spaced ? ' - size' : '-size';
    return s + fmtOffset(c.value, st);
}

export function formatAt(x?: Coord, y?: Coord, st: CodeStyle = DEFAULT_STYLE): string {
    return ['at', x && formatCoord(x, st), y && formatCoord(y, st)].filter(Boolean).join(' ');
}

export function formatSize(kind: 'width' | 'height', s: SizeSpec, keyword?: string): string {
    const k = keyword ?? (kind === 'width' ? 'wid' : 'hei');   // B1: wid/hei
    switch (s.mode) {
        case 'abs': return `${k} ${fmtNum(s.value ?? 0)}`;
        case 'same': return s.ref ? `${k}.${s.ref}` : k;
        default: return `${k} ${s.raw}`;
    }
}

/**
 * Канонический порядок частей гаджета для вставки новых. Правило B11 (PML_RULES):
 * у option `callback` ПЕРЕД `width` — иначе E3D падает с ошибкой разбора на `width`.
 * Новая часть вставляется перед первой существующей частью с бо́льшим рангом.
 */
const ORDER: Partial<Record<Clause['kind'], number>> = {
    type: 0, name: 1, tag: 3, text: 3, tagwidth: 4, anchor: 5, dock: 5, at: 6,
    callback: 7, tooltip: 8, pixmap: 9, width: 10, height: 11,
};

/** Место вставки новой части: начало первой части с бо́льшим рангом (или конец строки гаджета). */
/**
 * Ранг флага по графам синтаксиса Справочника PML 12.1 (разд. 2.5):
 * BUTTON LINKLabel/TOGGLE и подтипы FRAME — сразу после имени; LIST MULTIple/NORESELect/ZEROSELection,
 * SELECTOR SINGle, LINE VERTical/HORIZontal — после общих опций (at, callback, tooltip), перед <vshap>
 * (в т. ч. заметка памяти: `list … MULTIPLE at …` в E3D не грузится); BUTTON OK/APPLY/CANCEL/RESET/HELP — после <vshap>.
 */
const FLAG_RANK: Record<string, number> = {
    linklabel: 2, toggle: 2, tabset: 2, panel: 2, folduppanel: 2, toolbar: 2, indent: 2,
    multiple: 9.5, noreselect: 9.5, zeroselection: 9.5, single: 9.5, columns: 9.5, horizontal: 9.5, vertical: 9.5,
    ok: 12, apply: 12, cancel: 12, reset: 12, help: 12,
};

function clauseRank(c: Clause): number | undefined {
    if (c.kind === 'flag') return FLAG_RANK[c.value];
    // TEXT: `IS STRING|REAL … [FORMAT …]` — после WIDth (граф TEXT, рис. 2:65)
    if (c.kind === 'extra' && /^(is|format)$/i.test(c.text)) return 12;
    return ORDER[c.kind];
}

function insertPoint(g: ParsedGadget, kind: Clause['kind'] | number): { pos: number; atEnd: boolean } {
    const rank = typeof kind === 'number' ? kind : ORDER[kind] ?? 100;
    for (const c of g.clauses) {
        const r = clauseRank(c);
        if (r !== undefined && r > rank) return { pos: c.start, atEnd: false };
    }
    let end = 0;
    for (const c of g.clauses) if (c.kind !== 'comment') end = Math.max(end, c.end);
    return { pos: end, atEnd: true };
}

function clauseOf<K extends Clause['kind']>(g: ParsedGadget, kind: K): Extract<Clause, { kind: K }> | undefined {
    // при повторах действует последний
    let found: Clause | undefined;
    for (const c of g.clauses) if (c.kind === kind) found = c;
    return found as Extract<Clause, { kind: K }> | undefined;
}

const NOOP = (line: number): LineEdit => ({ line, start: 0, end: 0, newText: '' });

/** Заменить часть строки гаджета, удалить (text = undefined) или вставить её в каноническое место. */
function setClause(node: GadgetNode, kind: Clause['kind'], text: string | undefined): LineEdit {
    if (node.readOnly) throw new Error(node.readOnly);
    const c = clauseOf(node.gadget, kind);
    if (c) return { line: node.line, start: c.start, end: c.end, newText: text ?? '' };
    if (text === undefined) return NOOP(node.line);
    const { pos, atEnd } = insertPoint(node.gadget, kind);
    return { line: node.line, start: pos, end: pos, newText: atEnd ? ' ' + text : text + ' ' };
}

export function setPosition(node: GadgetNode, x?: Coord, y?: Coord, st: CodeStyle = DEFAULT_STYLE): LineEdit {
    return setClause(node, 'at', x || y ? formatAt(x, y, st) : undefined);
}

/** Позиция из текста пользователя, напр. `xmin .bnApply + 1` для одной оси. Другая ось сохраняется. */
export function parseCoordText(axis: 'x' | 'y', text: string): Coord | undefined {
    const g = parseGadgetLine(`button .tmp at ${text.trim()}`);
    const c = axis === 'x' ? g?.at?.x : g?.at?.y;
    // всё введённое должно разобраться (иначе — ошибка ввода)
    if (!g || !c || g.extras.length) return undefined;
    return c;
}

export function setSize(node: GadgetNode, kind: 'width' | 'height', size: SizeSpec | undefined): LineEdit {
    const old = clauseOf(node.gadget, kind);
    return setClause(node, kind, size && formatSize(kind, size, old?.keyword.split(/[._]/)[0]));
}

/** Строка PML: по правилу B3 — |…|; если внутри есть | — '…'. */
export const quote = (s: string) => (s.includes('|') ? `'${s.split("'").join("''")}'` : `|${s}|`);

/** PARAGRAPH: `TEXT text` — после позиции, перед размером (граф PARAGRAPH, рис. 2:40). */
export function setText(node: GadgetNode, text: string): LineEdit {
    if (node.readOnly) throw new Error(node.readOnly);
    const old = clauseOf(node.gadget, 'text');
    if (old) return { line: node.line, start: old.start, end: old.end, newText: `text ${quote(text)}` };
    const { pos, atEnd } = insertPoint(node.gadget, 9);
    return { line: node.line, start: pos, end: pos, newText: atEnd ? ` text ${quote(text)}` : `text ${quote(text)} ` };
}

export function setTag(node: GadgetNode, tag: string): LineEdit {
    if (node.readOnly) throw new Error(node.readOnly);
    const old = clauseOf(node.gadget, 'tag');
    if (old) return { line: node.line, start: old.start, end: old.end, newText: quote(tag) };
    // нового тега нет — после имени и флагов-подтипов (linklabel, tabset, panel…)
    let p = (clauseOf(node.gadget, 'name') ?? node.gadget.clauses[0]).end;
    for (const c of node.gadget.clauses) {
        if (c.kind === 'flag' && c.start >= p && /^(linklabel|toggle|tabset|panel|folduppanel|toolbar|indent)$/.test(c.value)) p = c.end;
        else if (c.start >= p) break;
    }
    return { line: node.line, start: p, end: p, newText: ' ' + quote(tag) };
}

export function setCallback(node: GadgetNode, value: string | undefined): LineEdit {
    const old = clauseOf(node.gadget, 'callback');
    return setClause(node, 'callback', value === undefined ? undefined : `${old?.keyword ?? 'callback'} ${quote(value)}`);
}

export function setTooltip(node: GadgetNode, value: string | undefined): LineEdit {
    return setClause(node, 'tooltip', value === undefined ? undefined : `tooltip ${quote(value)}`);
}

export function setAnchor(node: GadgetNode, value: string | undefined): LineEdit {
    return setClause(node, 'anchor', value ? `anchor ${value}` : undefined);
}

export function setDock(node: GadgetNode, value: string | undefined): LineEdit {
    return setClause(node, 'dock', value ? `dock ${value}` : undefined);
}

/** Включить/выключить флаг (multiple, linklabel…). Включение — сразу после тега (или имени). */
export function setFlag(node: GadgetNode, flag: string, on: boolean, word = flag): LineEdit {
    if (node.readOnly) throw new Error(node.readOnly);
    const c = node.gadget.clauses.find(x => x.kind === 'flag' && x.value === flag);
    if (!on) return c ? { line: node.line, start: c.start, end: c.end, newText: '' } : NOOP(node.line);
    if (c) return NOOP(node.line);
    // место — по графу синтаксиса гаджета (FLAG_RANK); неизвестный флаг — после тега
    const rank = FLAG_RANK[flag];
    if (rank === undefined) {
        const after = clauseOf(node.gadget, 'tag') ?? clauseOf(node.gadget, 'name') ?? node.gadget.clauses[0];
        return { line: node.line, start: after.end, end: after.end, newText: ' ' + word };
    }
    const { pos, atEnd } = insertPoint(node.gadget, rank);
    return { line: node.line, start: pos, end: pos, newText: atEnd ? ' ' + word : word + ' ' };
}

/**
 * Переименование гаджета: имя в определении + ссылки по всему файлу
 * (`!this.old`, `xmin.old`, `width.old`, `.old` в позиционировании).
 */
export function renameGadget(doc: FormDocument, node: GadgetNode, newName: string): LineEdit[] {
    const old = node.gadget.name;
    if (!old) return [];
    const edits: LineEdit[] = [];
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // !this.old, (x|y)(min|max|cen).old, width.old/height.old, min.old/max.old (width to …), .old в AT
    const re = new RegExp(`(!this\\.|\\b(?:[xy]?(?:min|max|cen)|wid\\w*|hei\\w*)\\.|(?<=\\s)\\.)${esc}(?![\\w])`, 'gi');
    doc.lines.forEach((l, i) => {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(l.text))) {
            const s = m.index + m[1].length;
            edits.push({ line: i, start: s, end: s + old.length, newText: newName });
        }
    });
    return edits;
}

/** Вставка строк гаджета после узла (или после последней строки его блока). */
export function insertLinesAfter(doc: FormDocument, after: number, lines: string[]): LinesEdit {
    return { line: after + 1, deleteCount: 0, insert: lines };
}

/** Удаление гаджета (для frame — вместе с содержимым и exit). */
export function deleteGadget(node: GadgetNode): LinesEdit {
    const end = node.endLine ?? node.line;
    return { line: node.line, deleteCount: end - node.line + 1, insert: [] };
}

/** Отступ строки (для вставки новых гаджетов в стиле соседей). */
export function indentOf(line: SourceLine): string {
    return /^[ \t]*/.exec(line.text)![0];
}

/** Применить правки к копии строк. LineEdit одной строки применяются справа налево. */
export function applyEdits(lines: SourceLine[], edits: Edit[]): SourceLine[] {
    const out = lines.map(l => ({ ...l }));
    // справа налево; вставки в одну точку — с конца списка, чтобы итоговый порядок совпал с порядком правок
    const lineEdits = edits.map((e, i) => ({ e, i })).filter((x): x is { e: LineEdit; i: number } => 'start' in x.e)
        // при равном start сначала замена диапазона [start, end), затем вставка в start
        .sort((a, b) => a.e.line - b.e.line || b.e.start - a.e.start || b.e.end - a.e.end || b.i - a.i).map(x => x.e);
    for (const e of lineEdits) {
        const t = out[e.line].text;
        let start = e.start;
        // при удалении части убираем и один пробел перед ней
        if (e.newText === '' && e.end > e.start && start > 0 && (t[start - 1] === ' ' || t[start - 1] === '\t')) start--;
        out[e.line].text = t.slice(0, start) + e.newText + t.slice(e.end);
    }
    const linesEdits = edits.filter((e): e is LinesEdit => 'deleteCount' in e).sort((a, b) => b.line - a.line);
    for (const e of linesEdits) {
        const eol = out.find(l => l.eol)?.eol ?? '\r\n';
        out.splice(e.line, e.deleteCount, ...e.insert.map(text => ({ text, eol })));
    }
    return out;
}

/**
 * Заглушка метода в конце файла (после последнего endmethod):
 *   define method .name()
 *   endmethod
 * Если метод уже есть — правок нет. Если в файле методы описаны блоками `-- Method:` (правило B2, шаблон новой
 * формы) — заглушка получает такой же блок с описанием description.
 */
export function addMethodStub(doc: FormDocument, name: string, body: string[] = [], description = ''): LinesEdit | undefined {
    if (doc.methods.some(m => m.name.toLowerCase() === name.toLowerCase())) return undefined;
    const last = doc.methods[doc.methods.length - 1];
    let at = last ? last.endLine + 1 : doc.lines.length;
    const unit = indentUnitOf(doc);
    const rule = '------------------------------------------------------------------------';
    const header = doc.lines.some(l => /^\s*--\s*Method:/i.test(l.text))
        ? [rule, '--', `-- Method:      ${name}`, `-- Description: ${description}`, '-- Method Type: Define',
            '-- Arguments:   none', '-- Return:      none', '--', rule]
        : [];
    const insert = ['', ...header, `define method .${name}()`, ...body.map(b => unit + b), 'endmethod'];
    // если файл не заканчивается переводом строки — вставляем после последней строки
    if (!last && doc.lines[doc.lines.length - 1].text === '') at = doc.lines.length - 1;
    return { line: at, deleteCount: 0, insert };
}

// ---------------------------------------------------------------------------------------------
// Новые гаджеты, ссылки, callback в .init()
// ---------------------------------------------------------------------------------------------

/** Типы гаджетов панели элементов: первая очередь (2026-10-07) и остальные (2026-10-08). */
export type NewGadgetType = 'button' | 'frame' | 'tabset' | 'list' | 'option' | 'textpane'
    | 'text' | 'toggle' | 'rtoggle' | 'radiogroup' | 'paragraph' | 'combo' | 'numericinput' | 'slider' | 'container' | 'line' | 'selector';

/**
 * Значения по умолчанию. Образцы записи — из SERVER_LIB (стиль проекта) и LOCAL_LIB (slider/numericinput/selector);
 * порядок частей — канонический (tag → tagwidth → at → … → width/height, правило B11), позицию `at` подставляет вызывающий.
 */
const DEFAULTS = (): Record<NewGadgetType, { base: string; tag: string; w?: number; h?: number }> => ({
    button: { base: 'button', tag: L('Кнопка', 'Button'), w: 10 },
    frame: { base: 'frame', tag: L('Рамка', 'Frame'), w: 20, h: 4 },
    tabset: { base: 'tabset', tag: '', w: 30, h: 8 },
    list: { base: 'list', tag: L('Список', 'List'), w: 20, h: 5 },
    option: { base: 'option', tag: L('Выбор', 'Option'), w: 10 },
    textpane: { base: 'textpane', tag: L('Текст', 'Text'), w: 30, h: 5 },
    text: { base: 'text', tag: L('Текст', 'Text'), w: 10 },
    toggle: { base: 'toggle', tag: L('Флажок', 'Check') },
    rtoggle: { base: 'rtoggle', tag: L('Вариант', 'Choice') },
    radiogroup: { base: 'radio', tag: L('Выбор', 'Option'), w: 20 },
    paragraph: { base: 'para', tag: L('Надпись', 'Label') },
    combo: { base: 'combo', tag: L('Список', 'List'), w: 10 },
    numericinput: { base: 'numeric', tag: L('Число', 'Number'), w: 6 },
    slider: { base: 'slider', tag: '', w: 20 },
    container: { base: 'net', tag: '', w: 30, h: 10 },
    line: { base: 'line', tag: '', w: 30, h: 0.5 },
    selector: { base: 'selector', tag: L('Элементы', 'Elements'), w: 25, h: 8 },
});

/** База имени нового гаджета (button1, para1, net1 …). */
export const newGadgetBase = (type: NewGadgetType) => DEFAULTS()[type].base;

/** Все имена гаджетов, member и методов формы (в нижнем регистре). */
export function usedNames(doc: FormDocument): Set<string> {
    const s = new Set<string>();
    const walk = (nodes: FormDocument['nodes']) => {
        for (const n of nodes) {
            if (n.kind === 'gadget') { if (n.gadget.name) s.add(n.gadget.name.toLowerCase()); if (n.children) walk(n.children); }
            else if (n.kind === 'member') s.add(n.name.toLowerCase());
            else if (n.kind === 'block') walk(n.children);
        }
    };
    walk(doc.nodes);
    for (const m of doc.methods) s.add(m.name.toLowerCase());
    return s;
}

export function uniqueName(doc: FormDocument, base: string): string {
    const used = usedNames(doc);
    for (let i = 1; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

/** Строки нового гаджета (без отступа контейнера — его добавляет вызывающий). */
export function newGadgetLines(type: NewGadgetType, name: string, at: string, indentUnit: string, pageName?: string): string[] {
    const d = DEFAULTS()[type];
    const size = [d.w !== undefined ? `wid ${d.w}` : '', d.h !== undefined ? `hei ${d.h}` : ''].filter(Boolean).join(' ');
    const tail = [at, size].filter(Boolean).join(' ');
    const t = quote(d.tag);
    switch (type) {
        case 'frame': return [`frame .${name} ${t} ${tail}`, 'exit'];
        case 'tabset': {
            const page = pageName ?? `${name}Page1`;
            return [`frame .${name} tabset ${tail}`, `${indentUnit}frame .${page} ${quote(L('Страница 1', 'Page 1'))}`, `${indentUnit}exit`, 'exit'];
        }
        case 'text': return [`text .${name} ${t} ${tail} is STRING`];
        case 'toggle': case 'rtoggle': return [`${type} .${name} ${t} ${at}`];
        // группа переключателей по Справочнику 12.1: FRAME с RTOGGLE внутри (RGROUP в 12.1 нет);
        // выбранный — !this.<frame>.val, callback группы — у frame
        case 'radiogroup': {
            const [o1, o2] = pageName ? pageName.split(',') : [`${name}Opt1`, `${name}Opt2`];
            return [`frame .${name} ${t} ${at}`, `${indentUnit}rtoggle .${o1} ${quote(L('Вариант 1', 'Choice 1'))}`,
                `${indentUnit}rtoggle .${o2} ${quote(L('Вариант 2', 'Choice 2'))}`, 'exit'];
        }
        case 'paragraph': return [`para .${name} ${at} text ${t}`];
        case 'combo': return [`combo .${name} ${t} tagwid 8 ${tail}`];
        case 'numericinput': return [`numericinput .${name} ${t} tagwid 8 ${at} range 0 100 ndp 0 ${size}`];
        case 'slider': return [`slider .${name} horizontal ${at} range 0 100 step 1 val 50 ${size}`];
        case 'container': return [`container .${name} PmlNetControl '' ${tail}`];
        case 'line': return [`line .${name} ${at} horiz ${size}`];
        case 'selector': return [`selector .${name} ${t} ${at} single ${size} database auto`];
        default: return [`${type} .${name} ${t} ${tail}`];
    }
}

/** Новая страница tabset. */
export function newPageLines(name: string, title: string): string[] {
    return [`frame .${name} ${quote(title)}`, 'exit'];
}

/** Единица отступа файла: таб или пробелы (B4: новый код — 4 пробела, при правке — стиль файла). */
export function indentUnitOf(doc: FormDocument): string {
    const end = doc.setupEndLine ?? doc.implicitEnd ?? doc.lines.length;
    let tabs = 0, spaces = 0, minSp = 99;
    for (let i = (doc.setupLine ?? 0) + 1; i < end; i++) {
        const m = /^([ \t]+)\S/.exec(doc.lines[i].text);
        if (!m) continue;
        if (m[1].startsWith('\t')) tabs++; else { spaces++; minSp = Math.min(minSp, m[1].length); }
    }
    if (tabs > spaces) return '\t';
    return spaces ? ' '.repeat(Math.min(Math.max(minSp, 2), 4)) : '    ';
}

/**
 * Куда вставлять новый гаджет в контейнер: после последнего гаджета контейнера (с его содержимым),
 * иначе сразу после строки frame / setup form. Возвращает индекс строки для вставки и отступ.
 */
export function insertionPoint(doc: FormDocument, container: GadgetNode | undefined): { line: number; indent: string } {
    const unit = indentUnitOf(doc);
    const children = container ? container.children ?? [] : doc.nodes;
    let lastIdx = -1;
    children.forEach((n, i) => { if (n.kind === 'gadget') lastIdx = i; });
    if (lastIdx >= 0) {
        const lastGadget = children[lastIdx] as GadgetNode;
        let line = (lastGadget.endLine ?? lastGadget.line) + (lastGadget.continuation ?? 0) + 1;
        let indent = indentOf(doc.lines[lastGadget.line]);
        // последний гаджет внутри if/do — вставлять после закрывающего endif/enddo (иначе новый гаджет станет условным)
        let depth = 0;
        for (let i = 0; i <= lastIdx; i++) depth += condDelta(children[i]);
        for (let i = lastIdx + 1; depth > 0 && i < children.length; i++) {
            depth += condDelta(children[i]);
            if (depth === 0) { line = children[i].line + 1; indent = indentOf(doc.lines[children[i].line]); }
        }
        return { line, indent };
    }
    if (container) return { line: container.line + 1, indent: indentOf(doc.lines[container.line]) + unit };
    // форма без гаджетов (новая из шаблона): перед закрывающим exit setup — после formTitle/initCall/member
    const end = doc.setupEndLine ?? doc.implicitEnd ?? doc.setupLine! + 1;
    let line = end;
    while (line - 1 > doc.setupLine! && doc.lines[line - 1].text.trim() === '') line--;   // не отрываться пустыми строками
    return { line, indent: unit };
}

function condDelta(n: FormDocument['nodes'][number]): number {
    if (n.kind !== 'statement') return 0;
    return n.keyword === 'if' || n.keyword === 'do' ? 1 : n.keyword === 'endif' || n.keyword === 'enddo' ? -1 : 0;
}

/** Строки, где упоминается гаджет (кроме его определения): AT/размеры других гаджетов и код. */
export function findReferences(doc: FormDocument, node: GadgetNode): number[] {
    const name = node.gadget.name;
    if (!name) return [];
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(!this\\.|\\b(?:[xy]?(?:min|max|cen)|wid\\w*|hei\\w*)[._]\\s*|(?<=\\s)\\.)${esc}(?![\\w])`, 'i');
    const own = new Set<number>();
    for (let i = node.line; i <= (node.endLine ?? node.line) + (node.continuation ?? 0); i++) own.add(i);
    const out: number[] = [];
    doc.lines.forEach((l, i) => { if (!own.has(i) && re.test(l.text)) out.push(i); });
    return out;
}

/** Метод инициализации формы: из `!this.initCall = |!this.X()|` в setup, иначе метод `init`. */
export function initMethod(doc: FormDocument): MethodInfo | undefined {
    const end = doc.setupEndLine ?? doc.implicitEnd ?? doc.lines.length;
    for (let i = (doc.setupLine ?? 0) + 1; i < end; i++) {
        const m = /^\s*!this\.initcall\s*=\s*[|']\s*!this\.(\w+)\s*\(/i.exec(doc.lines[i].text);
        if (m) return doc.methods.find(x => x.name.toLowerCase() === m[1].toLowerCase());
    }
    return doc.methods.find(x => x.name.toLowerCase() === 'init');
}

/**
 * Назначение callback в методе инициализации (правило B5): `!this.gad.callback = |…|` перед endmethod.
 * Если такое назначение уже есть — заменяется значение.
 */
export function setCallbackInInit(doc: FormDocument, gadget: string, value: string): Edit | undefined {
    const existing = doc.callbackAssigns.find(c => c.gadget.toLowerCase() === gadget.toLowerCase());
    if (existing) {
        const t = doc.lines[existing.line].text;
        const m = /[=]\s*(\|[^|]*\||'[^']*')/.exec(t)!;
        const start = m.index + m[0].indexOf(m[1]);
        return { line: existing.line, start, end: start + m[1].length, newText: quote(value) };
    }
    const init = initMethod(doc);
    if (!init) return undefined;
    const bodyIndent = indentOf(doc.lines[init.line]) + indentUnitOf(doc);
    return { line: init.endLine, deleteCount: 0, insert: [`${bodyIndent}!this.${gadget}.callback = ${quote(value)}`] };
}

// ---------------------------------------------------------------------------------------------
// Методы формы: вызовы, переименование, удаление (динамический callback, 2026-10-08)
// ---------------------------------------------------------------------------------------------

/** Имя метода из простого callback `!this.имя()` (без аргументов); иначе undefined. */
export function callbackMethod(value: string | undefined): string | undefined {
    const m = value && /^\s*!this\.(\w+)\s*\(\s*\)\s*$/i.exec(value);
    return m ? m[1] : undefined;
}

/** Вызовы метода в файле: `!this.имя(` и `!!форма.имя(` (без строки define method). */
export function methodCalls(doc: FormDocument, name: string): { line: number; start: number; end: number }[] {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:!this|!![A-Za-z]\\w*)\\.(${esc})(?=\\s*\\()`, 'gi');
    const out: { line: number; start: number; end: number }[] = [];
    doc.lines.forEach((l, i) => {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(l.text))) {
            const s = m.index + m[0].length - m[1].length;
            out.push({ line: i, start: s, end: s + m[1].length });
        }
    });
    return out;
}

/** Переименование метода: `define method .старое(`, строка `-- Method:` над ним и все вызовы. */
export function renameMethod(doc: FormDocument, m: MethodInfo, newName: string): LineEdit[] {
    const edits: LineEdit[] = [];
    const def = /^(\s*define\s+method\s+\.)(\w+)/i.exec(doc.lines[m.line].text);
    if (def) edits.push({ line: m.line, start: def[1].length, end: def[1].length + def[2].length, newText: newName });
    const head = methodHeaderStart(doc, m);
    for (let i = head; i < m.line; i++) {
        const h = /^(\s*--\s*Method:\s*)(\w+)/i.exec(doc.lines[i].text);
        if (h && h[2].toLowerCase() === m.name.toLowerCase()) edits.push({ line: i, start: h[1].length, end: h[1].length + h[2].length, newText: newName });
    }
    for (const c of methodCalls(doc, m.name)) edits.push({ ...c, newText: newName });
    return edits;
}

/** Первая строка блока описания метода (`----` / `-- Method:` вплотную над define method), иначе m.line. */
function methodHeaderStart(doc: FormDocument, m: MethodInfo): number {
    let i = m.line;
    while (i - 1 >= 0 && /^\s*--/.test(doc.lines[i - 1].text)) i--;
    // блок описания — только если в нём есть `-- Method:` этого метода (не «съедать» чужие комментарии)
    for (let j = i; j < m.line; j++) if (/^\s*--\s*Method:/i.test(doc.lines[j].text)) return i;
    return m.line;
}

/** В методе есть код (не только пустые строки и комментарии). */
export function methodHasBody(doc: FormDocument, m: MethodInfo): boolean {
    for (let i = m.line + 1; i < m.endLine; i++) {
        const t = doc.lines[i].text.trim();
        if (t && !t.startsWith('--') && !t.startsWith('$*')) return true;
    }
    return false;
}

/** Удаление метода вместе с блоком описания и одной пустой строкой перед ним. */
export function deleteMethod(doc: FormDocument, m: MethodInfo): LinesEdit {
    let start = methodHeaderStart(doc, m);
    if (start > 0 && doc.lines[start - 1].text.trim() === '') start--;
    return { line: start, deleteCount: m.endLine - start + 1, insert: [] };
}
