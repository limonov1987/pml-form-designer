// Приближённая раскладка формы по правилам F&M (PML_Guide, гл. 17 «Form layout»).
// Единицы — сетка формы: по X ширина условного символа, по Y высота строки.
// Это оценка для холста дизайнера: точный вид — только в E3D.
//
// Правила:
//  - контейнер (форма/frame) имеет свою сетку с началом в левом верхнем углу области содержимого;
//  - автоматическая расстановка: PATH (right по умолчанию), HDIST 0.2, VDIST 1.0 — зазоры между рамками гаджетов;
//  - AT: абсолютные координаты или край (min/max/cen) гаджета/формы + смещение, `-size` — минус свой размер;
//    не заданная в AT ось ставится автоматически;
//  - размеры: число; `width.gad` — как у гаджета; `width to max.gad` — до края; иначе — по умолчанию для типа;
//  - frame растёт по содержимому; страницы tabset совпадают по положению, видна одна.

import { FormDocument, FormNode, GadgetNode, LayoutNode } from './form';
import { Coord, ParsedGadget, SizeSpec } from './gadget';

export interface Box {
    x: number; y: number; w: number; h: number;
}

export interface LaidGadget {
    line: number;
    type: string;
    name: string;
    tag?: string;
    /** frame: подтип (tabset/panel/folduppanel/toolbar) */
    sub?: string;
    flags: string[];
    /** Абсолютные координаты на форме (единицы сетки). */
    box: Box;
    /** Положение относительно своего контейнера — то, что пишется в AT. */
    local: { x: number; y: number };
    /** Имя родительского frame ('' — форма). */
    parent: string;
    /** Абсолютное начало сетки контейнера (box.x - local.x). */
    origin: { x: number; y: number };
    /** Предыдущий гаджет того же контейнера (для AT без имени: `xmin`, `ymax`). */
    prev?: string;
    /** Положение вычислено не точно (макросы, сложные выражения, if в setup…). */
    approx: boolean;
    /** Причина приблизительности (первая найденная). */
    approxWhy?: string;
    /** Только просмотр (перенос строки `$`). */
    readOnly: boolean;
    /** Для страниц tabset: индекс страницы и имя tabset. */
    page?: { tabset: string; index: number };
    /** frame: смещение области содержимого относительно box (заголовок, отступы). */
    content?: { dx: number; dy: number };
    /** list/textpane: число видимых строк. */
    lines?: number;
    /** text/option/combo: ширина области тега (tagwidth или по тексту). */
    tagW?: number;
    pixmap?: boolean;
}

export interface FormLayout {
    width: number;
    height: number;
    gadgets: LaidGadget[];
    varChars: boolean;
}

const HDIST = 0.2;
const VDIST = 1.0;
/** Высота строки текстовых гаджетов, высота строки списка (в строках сетки). */
const LINE = 1;
const LIST_ROW = 0.75;
/** Отступы содержимого frame и формы (PADDING). */
const PAD_X = 0.5;
const PAD_Y = 0.25;
const FRAME_TAG_H = 0.75;
const TAB_H = 1.25;
/** Пикселей в единице сетки: у гаджетов с pixmap width/height заданы в пикселях. */
const PX_X = 8;
const PX_Y = 22;

interface Placed {
    g: LaidGadget;
    /** Рамка в координатах контейнера. */
    x: number; y: number; w: number; h: number;
}

/** PATH/HDIST/VDIST/ALIGN — общее текущее состояние формы (действует до следующей команды, через границы frame). */
interface LayoutCfg {
    path: 'right' | 'left' | 'up' | 'down';
    hdist: number; vdist: number;
    halign: 'left' | 'centre' | 'right';
    valign: 'top' | 'centre' | 'bottom';
}

interface Container {
    name: string;
    /** Абсолютное начало сетки контейнера. */
    ox: number; oy: number;
    placed: Placed[];
    last?: Placed;
    cfg: LayoutCfg;
    xmax: number; ymax: number;
}

/** Ширина текста в единицах сетки. VarChars — среднее по символам, FixChars — по условной ширине. */
export function textWidth(s: string | undefined, varChars: boolean): number {
    if (!s) return 0;
    if (!varChars) return s.length;
    let w = 0;
    for (const ch of s) {
        if (/[iljI.,:;'|!ft ]/.test(ch)) w += 0.45;
        else if (/[MWmwШЩЖЮМ@]/.test(ch)) w += 1.25;
        else if (/[A-ZА-ЯЁ0-9]/.test(ch)) w += 0.95;
        else w += 0.78;
    }
    return Math.round(w * 4) / 4;
}

export function layoutForm(doc: FormDocument): FormLayout {
    const varChars = doc.formAttrs.includes('varchars');
    const all = new Map<string, Placed & { c: Container }>();
    const out: LaidGadget[] = [];

    const cfg: LayoutCfg = { path: 'right', hdist: HDIST, vdist: VDIST, halign: 'left', valign: 'top' };
    const newContainer = (name: string, ox: number, oy: number): Container => ({ name, ox, oy, placed: [], cfg, xmax: 0, ymax: 0 });

    const cond: string[] = [];
    const layoutNodes = (nodes: FormNode[], c: Container, ctx: { approx: string; tabset?: string }) => {
        let pageIndex = 0;
        const outerApprox = ctx.approx;
        for (const n of nodes) {
            if (n.kind === 'layout') { applyLayoutCommand(c, n); continue; }
            if (n.kind === 'statement') {
                // $-макросы и if внутри setup делают дальнейшую раскладку неточной
                // гаджеты внутри if/do могут не создаваться или повторяться — помечаем только их
                if (/^(if|do)$/.test(n.keyword)) { cond.push(`${n.keyword} в setup (строка ${n.line + 1})`); ctx = { ...ctx, approx: ctx.approx || cond[0] }; }
                else if (/^(endif|enddo)$/.test(n.keyword)) { cond.pop(); if (!cond.length) ctx = { ...ctx, approx: outerApprox }; }
                else if (n.keyword.startsWith('$') && !ctx.approx) ctx = { ...ctx, approx: `макрос ${n.keyword} в setup (строка ${n.line + 1})` };
                continue;
            }
            if (n.kind === 'block') { layoutNodes(n.children, c, ctx); continue; }
            if (n.kind !== 'gadget') continue;
            const isPage = !!ctx.tabset && n.gadget.type === 'frame';
            placeGadget(n, c, ctx, isPage ? pageIndex++ : undefined);
        }
    };

    const placeGadget = (n: GadgetNode, c: Container, ctx: { approx: string; tabset?: string }, pageIndex?: number) => {
        const g = n.gadget;
        const sub = g.type === 'frame' ? g.flags.find(f => ['tabset', 'panel', 'folduppanel', 'toolbar'].includes(f)) : undefined;
        const lg: LaidGadget = {
            line: n.line, type: g.type, name: g.name, tag: g.tag ?? g.text, sub, flags: g.flags,
            box: { x: 0, y: 0, w: 0, h: 0 }, local: { x: 0, y: 0 }, parent: c.name, origin: { x: c.ox, y: c.oy }, prev: c.last?.g.name,
            approx: false, readOnly: !!n.readOnly,
            pixmap: g.flags.includes('pixmap'),
        };
        const mark = (why: string) => { if (!lg.approx) { lg.approx = true; lg.approxWhy = why; } };
        if (ctx.approx) mark(ctx.approx);
        const macro = g.extras.find(e => e.startsWith('$'));
        if (macro) mark(`макрос ${macro}`);
        if (['text', 'option', 'combo', 'numericinput'].includes(g.type)) lg.tagW = tagW(g, textWidth(g.tag, varChars));
        // 1. Размер (для frame — предварительный, уточняется после содержимого)
        let { w, h } = defaultSize(g, varChars, lg);
        const resolveSize = (spec: SizeSpec | undefined, kind: 'w' | 'h', cur: number, pos?: number): number => {
            if (!spec) return cur;
            if (spec.mode === 'abs') return kind === 'h' ? heightFromSpec(g, spec.value!, lg) : widthFromSpec(g, spec.value!, varChars);
            if (spec.mode === 'same') {
                const ref = spec.ref ? all.get(spec.ref.toLowerCase()) : c.last;
                if (ref) return kind === 'w' ? ref.w : ref.h;
                mark(`не найден гаджет .${spec.ref} для размера`); return cur;
            }
            if (spec.mode === 'to' && pos !== undefined) {
                const expr = spec.raw.trim().replace(/^to\s+/i, '');
                const m = /^(min|max|cen)(?:\s*[._]\s*(\w+)|\s+(form))?/i.exec(expr);
                if (m) {
                    const rn = (m[2] ?? m[3])?.toLowerCase();
                    const ref = rn ? (rn === 'form' ? undefined : all.get(rn)) : c.last;
                    const lo = kind === 'w' ? (ref ? ref.x : 0) : (ref ? ref.y : 0);
                    const sz = kind === 'w' ? (ref ? ref.w : c.xmax) : (ref ? ref.h : c.ymax);
                    const edge = m[1].toLowerCase() === 'min' ? lo : m[1].toLowerCase() === 'max' ? lo + sz : lo + sz / 2;
                    if (m[0].length !== expr.length) mark(`размер ${spec.raw}`);
                    return Math.max(1, edge - pos);
                }
            }
            mark(`размер ${spec.raw}`); return cur;
        };
        w = resolveSize(g.width, 'w', w);
        h = resolveSize(g.height, 'h', h);

        // 2. Положение
        const auto = autoPosition(c, w, h);
        let x = auto.x, y = auto.y;
        if (g.at) {
            if (g.at.x) { const r = resolveCoord(g.at.x, c, w, h); x = r.v; if (r.why) mark(r.why); }
            if (g.at.y) { const r = resolveCoord(g.at.y, c, w, h); y = r.v; if (r.why) mark(r.why); }
        }
        if (pageIndex !== undefined) { x = 0; y = 0; lg.page = { tabset: c.name, index: pageIndex }; }
        // размеры `to` зависят от положения
        if (g.width?.mode === 'to') w = resolveSize(g.width, 'w', w, x);
        if (g.height?.mode === 'to') h = resolveSize(g.height, 'h', h, y);

        // 3. Содержимое frame
        if (g.type === 'frame' && n.children) {
            const tabset = sub === 'tabset';
            // страница tabset: заголовок показывает вкладка, своей рамки и заголовка нет
            const dy = tabset ? TAB_H : (sub === 'panel' || sub === 'toolbar') ? 0 : pageIndex !== undefined ? PAD_Y
                : (g.tag !== undefined && g.tag.trim() !== '' ? FRAME_TAG_H : PAD_Y);
            const dx = tabset || sub === 'panel' ? 0 : PAD_X;
            lg.content = { dx, dy };
            const inner = newContainer(g.name, c.ox + x + dx, c.oy + y + dy);
            out.push(lg);
            // frame доступен для ссылок изнутри (`at xmin.fr+1`) ещё до раскладки содержимого
            if (g.name) all.set(g.name.toLowerCase(), { g: lg, x, y, w, h, c });
            layoutNodes(n.children, inner, { approx: ctx.approx, tabset: tabset ? g.name : undefined });
            const cw = inner.xmax + (tabset || sub === 'panel' ? 0 : PAD_X) + dx;
            const ch = inner.ymax + (tabset || sub === 'panel' ? 0 : PAD_Y) + dy;
            // frame растёт по содержимому, явный размер — минимальный
            w = Math.max(w, cw);
            h = Math.max(h, ch);
        } else {
            out.push(lg);
        }

        lg.local = { x, y };
        lg.box = { x: c.ox + x, y: c.oy + y, w, h };
        const p: Placed = { g: lg, x, y, w, h };
        c.placed.push(p);
        c.last = p;
        if (g.name) all.set(g.name.toLowerCase(), { ...p, c });
        c.xmax = Math.max(c.xmax, x + w);
        c.ymax = Math.max(c.ymax, y + h);
    };

    /** Координата AT в сетке контейнера c. */
    const resolveCoord = (co: Coord, c: Container, w: number, h: number): { v: number; why?: string } => {
        if (co.mode === 'abs') return { v: co.value, why: co.exact ? undefined : 'сложное выражение в AT' };
        const isX = co.axis === 'x';
        let lo: number, size: number, why = co.exact ? undefined : 'сложное выражение в AT';
        if (co.ref === 'form') {
            lo = 0; size = isX ? c.xmax : c.ymax;
        } else {
            const ref = co.ref ? all.get(co.ref.toLowerCase()) : (c.last && { ...c.last, c });
            // без имени и без предыдущего гаджета (первый в контейнере) — от начала контейнера
            if (!ref) { lo = 0; size = 0; if (co.ref) why = `не найден гаджет .${co.ref}`; }
            else {
                // гаджет из другого контейнера — переводим через абсолютные координаты
                const abs = isX ? ref.c.ox + ref.x : ref.c.oy + ref.y;
                lo = abs - (isX ? c.ox : c.oy);
                size = isX ? ref.w : ref.h;
            }
        }
        const edge = co.edge === 'max' ? lo + size : co.edge === 'cen' ? lo + size / 2 : lo;
        const own = co.minusSize ? (isX ? w : h) : 0;
        return { v: edge + co.value - own, why };
    };

    const root = newContainer('', PAD_X, PAD_Y);
    layoutNodes(doc.nodes, root, { approx: '' });
    return {
        width: Math.max(root.xmax + 2 * PAD_X, 10),
        height: Math.max(root.ymax + 2 * PAD_Y, 2),
        gadgets: out,
        varChars,
    };
}

function applyLayoutCommand(c: Container, n: LayoutNode) {
    const v = n.value.trim().toLowerCase();
    const num = parseFloat(v);
    switch (n.command) {
        case 'path': if (/^(right|left|up|down)/.test(v)) c.cfg.path = v.match(/^(right|left|up|down)/)![1] as LayoutCfg['path']; break;
        case 'hdist': if (!isNaN(num)) c.cfg.hdist = num; break;
        case 'vdist': if (!isNaN(num)) c.cfg.vdist = num; break;
        case 'halign': c.cfg.halign = v.startsWith('c') ? 'centre' : v.startsWith('r') ? 'right' : 'left'; break;
        case 'valign': c.cfg.valign = v.startsWith('c') ? 'centre' : v.startsWith('b') ? 'bottom' : 'top'; break;
    }
}

/** Автоматическое положение следующего гаджета по PATH/HDIST/VDIST/ALIGN. */
function autoPosition(c: Container, w: number, h: number): { x: number; y: number } {
    const l = c.last;
    if (!l) return { x: 0, y: 0 };
    switch (c.cfg.path) {
        case 'right': return { x: l.x + l.w + c.cfg.hdist, y: valignY(c, l, h) };
        case 'left': return { x: l.x - c.cfg.hdist - w, y: valignY(c, l, h) };
        case 'down': return { x: halignX(c, l, w), y: l.y + l.h + c.cfg.vdist };
        case 'up': return { x: halignX(c, l, w), y: l.y - c.cfg.vdist - h };
    }
}

const valignY = (c: Container, l: Placed, h: number) =>
    c.cfg.valign === 'top' ? l.y : c.cfg.valign === 'bottom' ? l.y + l.h - h : l.y + (l.h - h) / 2;
const halignX = (c: Container, l: Placed, w: number) =>
    c.cfg.halign === 'left' ? l.x : c.cfg.halign === 'right' ? l.x + l.w - w : l.x + (l.w - w) / 2;

/** Размер по умолчанию по типу гаджета (единицы сетки). */
function defaultSize(g: ParsedGadget, varChars: boolean, lg: LaidGadget): { w: number; h: number } {
    const tw = textWidth(g.tag, varChars);
    switch (g.type) {
        case 'button':
            if (g.flags.includes('linklabel')) return { w: Math.max(tw, 2), h: LINE };
            if (g.flags.includes('pixmap') && !g.tag) return { w: 2.5, h: LINE * 1.2 };
            return { w: Math.max(tw + 2, 4), h: LINE * 1.1 };
        case 'toggle': case 'rtoggle': return { w: tw + 2, h: LINE };
        case 'text': case 'numericinput': return { w: tagW(g, tw) + 10, h: LINE };
        case 'option': case 'combo': return { w: tagW(g, tw) + 10 + 1.5, h: LINE };
        case 'paragraph': return { w: Math.max(textWidth(g.text ?? g.tag, varChars), 1), h: LINE };
        case 'list': case 'selector': case 'textpane': {
            lg.lines = 5;
            const tagH = g.tag !== undefined && g.tag.trim() !== '' ? LINE : 0;
            return { w: 15, h: tagH + lg.lines * LIST_ROW + 0.3 };
        }
        case 'frame': return { w: Math.max(tw + 2, 2), h: 1 };
        case 'line': return g.flags.includes('vertical') ? { w: 0.5, h: 3 } : { w: 10, h: 0.5 };
        case 'slider': return { w: 10, h: LINE };
        case 'container': return { w: 20, h: 6 };
        case 'view': case 'alpha': return { w: 20, h: 10 };
        case 'rgroup': return { w: tw + 10, h: LINE * 1.5 };
        default: return { w: 5, h: LINE };
    }
}

/** Ширина тега с учётом tagwidth. */
function tagW(g: ParsedGadget, tw: number): number {
    const c = g.clauses.find(x => x.kind === 'tagwidth') as { value: number } | undefined;
    if (c && !isNaN(c.value)) return c.value;
    return tw ? tw + 0.5 : 0;
}

/** width N: для text/option/combo/toggle — без тега; для button/frame/paragraph — весь гаджет. */
function widthFromSpec(g: ParsedGadget, v: number, varChars: boolean): number {
    if (g.flags.includes('pixmap') && (g.type === 'button' || g.type === 'paragraph' || g.type === 'toggle')) return v / PX_X;
    switch (g.type) {
        case 'text': case 'numericinput': return tagW(g, textWidth(g.tag, varChars)) + v;
        case 'option': case 'combo': return tagW(g, textWidth(g.tag, varChars)) + v + 1.5;
        case 'toggle': case 'rtoggle': return textWidth(g.tag, varChars) + 2;
        default: return v;
    }
}

/** height N: для list/selector/textpane — число строк (+ тег сверху). */
function heightFromSpec(g: ParsedGadget, v: number, lg: LaidGadget): number {
    if (g.flags.includes('pixmap') && (g.type === 'button' || g.type === 'paragraph' || g.type === 'toggle')) return v / PX_Y;
    if (g.type === 'list' || g.type === 'selector' || g.type === 'textpane') {
        lg.lines = v;
        const tagH = g.tag !== undefined && g.tag.trim() !== '' ? LINE : 0;
        return tagH + v * LIST_ROW + 0.3;
    }
    return v;
}

// ---------- Обратный пересчёт: размер рамки на холсте → значение width/height в коде ----------

/** Значение `width N` по ширине рамки гаджета (обратное widthFromSpec). */
export function widthSpecFromBox(g: ParsedGadget, w: number, varChars: boolean): number {
    if (g.flags.includes('pixmap') && (g.type === 'button' || g.type === 'paragraph' || g.type === 'toggle')) return Math.round(w * PX_X);
    const tw = tagW(g, textWidth(g.tag, varChars));
    switch (g.type) {
        case 'text': case 'numericinput': return round1(Math.max(1, w - tw));
        case 'option': case 'combo': return round1(Math.max(1, w - tw - 1.5));
        default: return round1(Math.max(1, w));
    }
}

/** Значение `height N` по высоте рамки (для list/textpane — число строк). */
export function heightSpecFromBox(g: ParsedGadget, h: number): number {
    if (g.flags.includes('pixmap') && (g.type === 'button' || g.type === 'paragraph' || g.type === 'toggle')) return Math.round(h * PX_Y);
    if (g.type === 'list' || g.type === 'selector' || g.type === 'textpane') {
        const tagH = g.tag !== undefined && g.tag.trim() !== '' ? LINE : 0;
        return Math.max(1, Math.round((h - tagH - 0.3) / LIST_ROW));
    }
    return round1(Math.max(0.5, h));
}

const round1 = (v: number) => Math.round(v * 10) / 10;
