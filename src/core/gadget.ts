// Разбор строки определения гаджета: `button .ok |OK| at xmax form-size ymax width 10 callback |...|`.
// Строка не переписывается целиком: каждая распознанная часть (clause) знает свой диапазон в строке,
// всё нераспознанное остаётся в extras и при правках не трогается.

import { Token, tokenize, kw } from './lexer';

export const GADGET_TYPES = [
    'button', 'frame', 'list', 'option', 'textpane',          // первая очередь (решение 2026-10-07)
    'text', 'toggle', 'rtoggle', 'paragraph', 'combo', 'selector',
    'slider', 'numericinput', 'container', 'line', 'alpha', 'view', 'rgroup',
] as const;
export type GadgetType = typeof GADGET_TYPES[number];

// Минимальная длина сокращения ключевого слова типа гаджета (para, butt, ...)
const TYPE_MIN: Record<string, number> = {
    button: 4, frame: 5, list: 4, option: 4, textpane: 8, text: 4, toggle: 4, rtoggle: 5,
    paragraph: 4, combo: 5, selector: 4, slider: 4, numericinput: 7, container: 9, line: 4,
    alpha: 5, view: 4, rgroup: 6,
};

export function gadgetTypeOf(word: string): GadgetType | undefined {
    const w = word.toLowerCase();
    // textpane проверяем раньше text, rtoggle раньше toggle — у них разные полные слова, конфликтов нет
    for (const t of GADGET_TYPES) if (kw(w, t, TYPE_MIN[t])) return t;
    return undefined;
}

/** Координата позиции (одна ось) из AT. */
export interface Coord {
    axis: 'x' | 'y';
    /** abs — число; rel — относительно края гаджета/формы; */
    mode: 'abs' | 'rel';
    /** Для abs — значение; для rel — смещение (если выражение простое). */
    value: number;
    /** rel: край min/max/cen */
    edge?: 'min' | 'max' | 'cen';
    /** rel: имя гаджета без точки, 'form' или '' (последний размещённый гаджет). */
    ref?: string;
    /** rel: из выражения вычитается собственный размер (`xmax form-size`). */
    minusSize?: boolean;
    /** false — выражение сложнее, чем мы моделируем (умножение, hdist, padding…): показываем как текст. */
    exact: boolean;
    start: number;
    end: number;
}

/** Размер (width/height). */
export interface SizeSpec {
    /** abs — число; same — как у гаджета (`width.gad` / `width` без значения); to — до края (`width to max.gad`). */
    mode: 'abs' | 'same' | 'to' | 'raw';
    value?: number;
    ref?: string;
    raw: string;
}

export type Clause =
    | { kind: 'type'; start: number; end: number }
    | { kind: 'name'; start: number; end: number; name: string }
    | { kind: 'tag'; start: number; end: number; value: string }
    | { kind: 'at'; start: number; end: number; x?: Coord; y?: Coord }
    | { kind: 'width' | 'height'; start: number; end: number; size: SizeSpec; keyword: string }
    | { kind: 'callback'; start: number; end: number; value: string; keyword: string }
    | { kind: 'tooltip'; start: number; end: number; value: string }
    | { kind: 'anchor'; start: number; end: number; value: string }
    | { kind: 'dock'; start: number; end: number; value: string }
    | { kind: 'tagwidth'; start: number; end: number; value: number }
    | { kind: 'text'; start: number; end: number; value: string }
    | { kind: 'pixmap'; start: number; end: number; value: string }
    | { kind: 'flag'; start: number; end: number; value: string }
    | { kind: 'extra'; start: number; end: number; text: string }
    | { kind: 'comment'; start: number; end: number; text: string };

export interface ParsedGadget {
    type: GadgetType;
    name: string;        // без точки; '' если имени нет
    clauses: Clause[];
    /** Удобные ссылки на распознанные части */
    tag?: string;
    at?: Extract<Clause, { kind: 'at' }>;
    /** Повторные AT (встречаются: `at xmin ymin at x0 ymax+0.25`) — действует последний. */
    atCount: number;
    width?: SizeSpec;
    height?: SizeSpec;
    callback?: string;
    tooltip?: string;
    pixmap?: string;
    /** paragraph: `text '...'` */
    text?: string;
    anchor?: string;
    dock?: string;
    flags: string[];
    extras: string[];
}

// Флаги по типам гаджетов (полные слова, мин. длина сокращения)
const FLAGS: [string, number][] = [
    ['linklabel', 5], ['toggle', 6], ['ok', 2], ['cancel', 6], ['apply', 5], ['reset', 5], ['help', 4],
    ['single', 6], ['multiple', 4], ['noreselect', 6], ['zeroselection', 7], ['noselection', 7], ['columns', 6],
    ['tabset', 6], ['toolbar', 7], ['panel', 5], ['indent', 6], ['folduppanel', 6], ['radio', 5],
    ['horizontal', 4], ['vertical', 4], ['noeditable', 6], ['editable', 4], ['nores', 5],
    ['active', 6], ['inactive', 8], ['visible', 7], ['invisible', 9], ['nobox', 5], ['pixmap', 3], ['core', 4],
];

function flagOf(word: string): string | undefined {
    for (const [f, m] of FLAGS) if (kw(word, f, m)) return f;
    return undefined;
}

// Ключевые слова, которые обрывают разбор выражений AT/WIDTH
const STOP_WORDS = ['at', 'width', 'height', 'callback', 'call', 'tooltip', 'anchor', 'dock', 'tagwidth',
    'length', 'lines', 'pixmap', 'is', 'text', 'tag', 'form', 'scroll', 'format', 'core', 'background',
    'states', 'select', 'noecho', 'popup', 'linklabel', 'tagwid', 'tooltip'];

// xmin.gad, xmin_gad (старая запись), xmax0.5 (смещение слитно)
const EDGE_RE = /^(x|y)(min|max|cen)(?:[._]([A-Za-z]\w*))?(\d*\.?\d+)?$/i;
const AXIS_NUM_RE = /^(x|y)(\d*\.?\d+)?$/i;

function num(t: Token | undefined): number | undefined {
    return t && t.kind === 'number' ? parseFloat(t.text) : undefined;
}

/**
 * Разбор позиции после AT. Возвращает индекс первого не потреблённого токена.
 */
function parseAt(toks: Token[], i: number, clause: Extract<Clause, { kind: 'at' }>): number {
    let pendingAbs: number[] = []; // `at 3 3.5` без осей
    while (i < toks.length) {
        const t = toks[i];
        if (t.kind === 'word') {
            const w = t.text;
            const edge = EDGE_RE.exec(w);
            const axisNum = AXIS_NUM_RE.exec(w);
            if (edge) {
                const axis = edge[1].toLowerCase() as 'x' | 'y';
                const c: Coord = {
                    axis, mode: 'rel', edge: edge[2].toLowerCase() as Coord['edge'], ref: edge[3] ?? '',
                    value: edge[4] ? parseFloat(edge[4]) : 0, exact: true, start: t.start, end: t.end,
                };
                i++;
                // `XMIN gadget1`, `XMIN .gad`, `XMAX FORM`
                const nx = toks[i];
                if (!edge[3] && nx) {
                    if (nx.kind === 'name') { c.ref = nx.text.slice(1); c.end = nx.end; i++; }
                    else if (nx.kind === 'word' && nx.text.toLowerCase() === 'form') { c.ref = 'form'; c.end = nx.end; i++; }
                    else if (nx.kind === 'word' && /^[A-Za-z]\w*$/.test(nx.text) && !EDGE_RE.test(nx.text) && !AXIS_NUM_RE.test(nx.text)
                        && !STOP_WORDS.includes(nx.text.toLowerCase()) && !flagOf(nx.text) && !isKeyword(nx.text)) {
                        c.ref = nx.text; c.end = nx.end; i++;
                    }
                }
                i = parseOffset(toks, i, c);
                setCoord(clause, c);
                continue;
            }
            if (axisNum) {
                const axis = axisNum[1].toLowerCase() as 'x' | 'y';
                let value: number | undefined = axisNum[2] !== undefined ? parseFloat(axisNum[2]) : undefined;
                let end = t.end;
                i++;
                if (value === undefined) {
                    // `x 3`, `x -2`
                    let sign = 1;
                    if (toks[i]?.kind === 'op' && (toks[i].text === '-' || toks[i].text === '+') && num(toks[i + 1]) !== undefined) {
                        sign = toks[i].text === '-' ? -1 : 1; i++;
                    }
                    const v = num(toks[i]);
                    if (v === undefined) { i--; break; }
                    value = sign * v; end = toks[i].end; i++;
                }
                const c: Coord = { axis, mode: 'abs', value, exact: true, start: t.start, end };
                i = parseOffset(toks, i, c);
                setCoord(clause, c);
                continue;
            }
            break;
        }
        if (t.kind === 'number' || (t.kind === 'op' && t.text === '-' && num(toks[i + 1]) !== undefined)) {
            // `at 3 3.5`
            let sign = 1; const start = t.start;
            if (t.kind === 'op') { sign = -1; i++; }
            pendingAbs.push(sign * parseFloat(toks[i].text));
            const axis: 'x' | 'y' = pendingAbs.length === 1 ? 'x' : 'y';
            setCoord(clause, { axis, mode: 'abs', value: sign * parseFloat(toks[i].text), exact: true, start, end: toks[i].end });
            i++;
            if (pendingAbs.length === 2) pendingAbs = [];
            continue;
        }
        break;
    }
    return i;
}

/** Хвост выражения координаты: `+0.5`, `- size`, `-0.5 * size`, `+ hdist`. */
function parseOffset(toks: Token[], i: number, c: Coord): number {
    while (i < toks.length) {
        const op = toks[i];
        if (op.kind !== 'op' || !'+-*/'.includes(op.text)) break;
        const nx = toks[i + 1];
        if (!nx) break;
        if (nx.kind === 'number') {
            if (op.text === '+' || op.text === '-') {
                // `-0.5 * size` — не моделируем
                if (toks[i + 2]?.kind === 'op' && toks[i + 2].text === '*') c.exact = false;
                c.value += (op.text === '-' ? -1 : 1) * parseFloat(nx.text);
            } else {
                c.exact = false;
            }
            c.end = nx.end; i += 2;
            continue;
        }
        if (nx.kind === 'word' && /^(size|hdist|vdist|padding)$/i.test(nx.text)) {
            if (nx.text.toLowerCase() === 'size' && op.text === '-' && c.mode === 'rel') c.minusSize = true;
            else c.exact = false;
            c.end = nx.end; i += 2;
            continue;
        }
        break;
    }
    return i;
}

function setCoord(clause: Extract<Clause, { kind: 'at' }>, c: Coord) {
    if (c.axis === 'x') clause.x = c; else clause.y = c;
    clause.end = Math.max(clause.end, c.end);
}

function isKeyword(w: string): boolean {
    return STOP_WORDS.some(k => kw(w, k, Math.min(k.length, 3))) || !!flagOf(w) || !!gadgetTypeOf(w);
}

/** Разбор размера после WIDTH/HEIGHT. kwTok может быть `width.gad`. */
function parseSize(toks: Token[], i: number, kwTok: Token, dotRef: string | undefined): { size: SizeSpec; next: number; end: number } {
    if (dotRef) return { size: { mode: 'same', ref: dotRef, raw: kwTok.text }, next: i, end: kwTok.end };
    const t = toks[i];
    if (t && t.kind === 'number') return { size: { mode: 'abs', value: parseFloat(t.text), raw: t.text }, next: i + 1, end: t.end };
    if (t && (t.kind === 'macro' || t.kind === 'var')) return { size: { mode: 'raw', raw: t.text }, next: i + 1, end: t.end };
    if (t && t.kind === 'name') return { size: { mode: 'same', ref: t.text.slice(1), raw: t.text }, next: i + 1, end: t.end };
    if (t && t.kind === 'word' && t.text.toLowerCase() === 'to') {
        // width to max.fr1 * 0.5 + hdist — сохраняем текстом
        let j = i + 1; let end = t.end;
        while (j < toks.length) {
            const x = toks[j];
            if (x.kind === 'word' && (/^(min|max|cen)(\..+)?$/i.test(x.text) || /^(size|hdist|vdist|padding|form)$/i.test(x.text))) { end = x.end; j++; continue; }
            if (x.kind === 'name' || x.kind === 'number') { end = x.end; j++; continue; }
            if (x.kind === 'op' && '+-*/'.includes(x.text)) { end = x.end; j++; continue; }
            break;
        }
        return { size: { mode: 'to', raw: '' }, next: j, end };
    }
    // `width` без значения — как у последнего гаджета
    return { size: { mode: 'same', ref: '', raw: '' }, next: i, end: kwTok.end };
}

export function parseGadgetLine(line: string, tokens = tokenize(line)): ParsedGadget | undefined {
    const toks = tokens.filter(t => t.kind !== 'comment');
    const comment = tokens.find(t => t.kind === 'comment');
    if (!toks.length || toks[0].kind !== 'word') return undefined;
    const type = gadgetTypeOf(toks[0].text);
    if (!type) return undefined;

    const g: ParsedGadget = { type, name: '', clauses: [], atCount: 0, flags: [], extras: [] };
    g.clauses.push({ kind: 'type', start: toks[0].start, end: toks[0].end });
    let i = 1;
    if (toks[i]?.kind === 'name') {
        g.name = toks[i].text.slice(1);
        g.clauses.push({ kind: 'name', start: toks[i].start, end: toks[i].end, name: g.name });
        i++;
    } else if (toks[i]?.kind === 'var' && /^!this\./i.test(toks[i].text)) {
        // TOGGLE !This.TOGGLENAME — допустимая форма имени
        g.name = toks[i].text.slice(6);
        g.clauses.push({ kind: 'name', start: toks[i].start, end: toks[i].end, name: g.name });
        i++;
    }

    while (i < toks.length) {
        const t = toks[i];
        if (t.kind === 'string') {
            if (g.tag === undefined) {
                g.tag = t.value!;
                g.clauses.push({ kind: 'tag', start: t.start, end: t.end, value: t.value! });
            } else {
                g.extras.push(t.text);
                g.clauses.push({ kind: 'extra', start: t.start, end: t.end, text: t.text });
            }
            i++;
            continue;
        }
        if (t.kind === 'word') {
            const [base, dotRef] = splitDot(t.text);
            const w = base.toLowerCase();
            const strArg = (kind: 'callback' | 'tooltip') => {
                const s = toks[i + 1];
                if (s?.kind === 'string') {
                    const c = kind === 'callback'
                        ? { kind, start: t.start, end: s.end, value: s.value!, keyword: t.text } as Clause
                        : { kind, start: t.start, end: s.end, value: s.value! } as Clause;
                    g.clauses.push(c);
                    if (kind === 'callback') g.callback = s.value; else g.tooltip = s.value;
                    i += 2;
                    return true;
                }
                return false;
            };

            if (w === 'at') {
                const c: Extract<Clause, { kind: 'at' }> = { kind: 'at', start: t.start, end: t.end };
                i = parseAt(toks, i + 1, c);
                g.clauses.push(c);
                g.at = c; g.atCount++;
                continue;
            }
            if (kw(w, 'width', 3) || kw(w, 'height', 3) || kw(w, 'lines', 3) || ((type === 'list' || type === 'selector' || type === 'textpane') && kw(w, 'length', 3))) {
                const kind = kw(w, 'width', 3) ? 'width' : 'height';
                const r = parseSize(toks, i + 1, t, dotRef);
                if (r.size.mode === 'to') r.size.raw = line.slice(toks[i + 1].start, r.end);
                g.clauses.push({ kind, start: t.start, end: r.end, size: r.size, keyword: t.text });
                if (kind === 'width') g.width = r.size; else g.height = r.size;
                i = r.next;
                continue;
            }
            if ((kw(w, 'callback', 4) || w === 'call') && strArg('callback')) continue;
            if (kw(w, 'tooltip', 4) && strArg('tooltip')) continue;
            if (w === 'text' && toks[i + 1]?.kind === 'string') {
                // paragraph .p text 'содержимое'
                g.text = toks[i + 1].value;
                g.clauses.push({ kind: 'text', start: t.start, end: toks[i + 1].end, value: toks[i + 1].value! });
                i += 2;
                continue;
            }
            if (kw(w, 'tagwidth', 6) && toks[i + 1] && ['number', 'macro', 'var'].includes(toks[i + 1].kind)) {
                g.clauses.push({ kind: 'tagwidth', start: t.start, end: toks[i + 1].end, value: num(toks[i + 1]) ?? NaN });
                i += 2;
                continue;
            }
            if (kw(w, 'anchor', 3) || kw(w, 'dock', 4)) {
                // anchor top + left + right / anchor l+b / dock fill
                let j = i + 1; let end = t.end;
                while (j < toks.length) {
                    const x = toks[j];
                    if (x.kind === 'word' && /^(l|r|t|b|left|right|top|bottom|all|none|fill)$/i.test(x.text)) { end = x.end; j++; continue; }
                    if (x.kind === 'op' && x.text === '+') { j++; continue; }
                    break;
                }
                const value = line.slice(toks[i + 1]?.start ?? t.end, end).trim();
                const kind = kw(w, 'anchor', 3) ? 'anchor' : 'dock';
                g.clauses.push({ kind, start: t.start, end, value });
                if (kind === 'anchor') g.anchor = value; else g.dock = value;
                i = j;
                continue;
            }
            const f = flagOf(w);
            if (f === 'pixmap' && toks[i + 1]?.kind === 'string') {
                g.pixmap = toks[i + 1].value;
                g.clauses.push({ kind: 'pixmap', start: t.start, end: toks[i + 1].end, value: toks[i + 1].value! });
                g.flags.push(f);
                i += 2;
                continue;
            }
            if (f) {
                g.flags.push(f);
                g.clauses.push({ kind: 'flag', start: t.start, end: t.end, value: f });
                i++;
                continue;
            }
        }
        g.extras.push(t.text);
        g.clauses.push({ kind: 'extra', start: t.start, end: t.end, text: t.text });
        i++;
    }
    if (comment) g.clauses.push({ kind: 'comment', start: comment.start, end: comment.end, text: comment.text });
    return g;
}

function splitDot(word: string): [string, string | undefined] {
    const k = word.search(/[._]/);
    return k < 0 ? [word, undefined] : [word.slice(0, k), word.slice(k + 1)];
}
