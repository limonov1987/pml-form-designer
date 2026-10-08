// Разбор файла .pmlfrm в дерево без потерь (вариант Б, решение 2026-10-07).
// Исходный текст хранится построчно вместе с концами строк: print(doc) === исходный текст.
// Дерево лишь ссылается на номера строк; правки делаются заменой фрагментов строк (см. edits.ts).

import { tokenize, Token, kw } from './lexer';
import { parseGadgetLine, ParsedGadget } from './gadget';

export interface SourceLine {
    text: string;   // без конца строки
    eol: string;    // '\r\n' | '\n' | '\r' | ''
}

export type NodeKind = 'gadget' | 'block' | 'layout' | 'member' | 'statement' | 'comment' | 'blank' | 'raw';

export interface BaseNode { kind: NodeKind; line: number }

export interface GadgetNode extends BaseNode {
    kind: 'gadget';
    /** Число строк-продолжений (`$` в конце или многострочная строка). */
    continuation?: number;
    /** Причина, по которой дизайнер не правит гаджет (многострочный, имя-макрос…). */
    readOnly?: string;
    /** Гаджет внутри if/do в setup — создаётся по условию или в цикле. */
    conditional?: boolean;
    gadget: ParsedGadget;
    /** Для frame — вложенные узлы до соответствующего exit. */
    children?: FormNode[];
    endLine?: number;
}

/** Блок, не являющийся гаджетом дизайнера: menu/bar … exit. */
export interface BlockNode extends BaseNode {
    kind: 'block';
    keyword: string;   // menu | bar
    name: string;
    children: FormNode[];
    endLine?: number;
}

/** Команды раскладки: path, hdist, vdist, halign, valign. */
export interface LayoutNode extends BaseNode {
    kind: 'layout';
    command: 'path' | 'hdist' | 'vdist' | 'halign' | 'valign';
    value: string;
}

export interface MemberNode extends BaseNode { kind: 'member'; name: string; type: string }
/** Прочие операторы внутри setup (присваивания, title, track, using, $-макросы, if…). */
export interface StatementNode extends BaseNode { kind: 'statement'; keyword: string }
export interface TriviaNode extends BaseNode { kind: 'comment' | 'blank' | 'raw' }

export type FormNode = GadgetNode | BlockNode | LayoutNode | MemberNode | StatementNode | TriviaNode;

export interface MethodInfo { name: string; line: number; endLine: number }

/** Назначение callback вне setup: `!this.gad.callback = |...|` */
export interface CallbackAssign { gadget: string; value: string; line: number; method?: string }

export interface FormDocument {
    lines: SourceLine[];
    /** Для отчётов: исходная кодировка и т. п. задаётся снаружи. */
    formName?: string;
    /** Номер строки `setup form` и закрывающего `exit`. */
    setupLine?: number;
    setupEndLine?: number;
    /** Атрибуты формы из строки setup: dialog, document, resize, varchars, noalign, … */
    formAttrs: string[];
    nodes: FormNode[];
    methods: MethodInfo[];
    callbackAssigns: CallbackAssign[];
    problems: { line: number; message: string }[];
    warnings: { line: number; message: string }[];
    /** Строка define method, на которой setup закончился без парного exit. */
    implicitEnd?: number;
}

export function splitLines(text: string): SourceLine[] {
    const out: SourceLine[] = [];
    const re = /\r\n|\n|\r/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        out.push({ text: text.slice(last, m.index), eol: m[0] });
        last = m.index + m[0].length;
    }
    out.push({ text: text.slice(last), eol: '' });
    return out;
}

export function printLines(lines: SourceLine[]): string {
    return lines.map(l => l.text + l.eol).join('');
}

const SETUP_RE = /^\s*(setup|layout)\s+form\s+!!([\w.]+)(.*)$/i;
const DEFINE_METHOD_RE = /^\s*define\s+method\s+\.([\w]+)/i;
const ENDMETHOD_RE = /^\s*endmethod\b/i;
const CB_ASSIGN_RE = /^\s*!this\.(\w+)\.callback\s*=\s*(\|[^|]*\||'[^']*')/i;

/** Строка продолжается на следующей: `$` в конце или незакрытая строка '…' / |…| (встречается в LOCAL_LIB). */
function isContinued(toks: Token[]): boolean {
    const t = toks.filter(x => x.kind !== 'comment');
    const last = t[t.length - 1];
    if (!last) return false;
    return (last.kind === 'macro' && last.text === '$') || (last.kind === 'string' && !!last.unterminated);
}

function isAddOnlyBlock(owner?: GadgetNode | BlockNode): boolean {
    if (!owner) return false;
    // rgroup (в т. ч. `rgroup … frame`) содержит только add: abatemplatesht.pmlfrm сходится по exit лишь при такой трактовке
    return owner.kind === 'block' || owner.gadget.type === 'rgroup';
}

/** Первое слово следующей строки с кодом (пропуская пустые и комментарии). */
function nextCodeWord(lines: SourceLine[], i: number): string {
    for (let j = i + 1; j < lines.length; j++) {
        const t = tokenize(lines[j].text);
        if (!t.length || t[0].kind === 'comment') continue;
        return firstWord(t);
    }
    return '';
}

function firstWord(toks: Token[]): string {
    return toks[0]?.kind === 'word' ? toks[0].text.toLowerCase() : '';
}

export function parseForm(text: string): FormDocument {
    const lines = splitLines(text);
    const doc: FormDocument = { lines, formAttrs: [], nodes: [], methods: [], callbackAssigns: [], problems: [], warnings: [] };

    // 1. Строка setup form
    let i = 0;
    for (; i < lines.length; i++) {
        const m = SETUP_RE.exec(lines[i].text);
        if (m) {
            doc.formName = m[2];
            doc.setupLine = i;
            doc.formAttrs = tokenize(m[3]).filter(t => t.kind === 'word').map(t => t.text.toLowerCase());
            break;
        }
    }

    // 2. Тело setup до парного exit
    if (doc.setupLine !== undefined) {
        const stack: { children: FormNode[]; owner?: GadgetNode | BlockNode }[] = [{ children: doc.nodes }];
        let cond = 0;   // глубина if/do внутри setup
        for (i = doc.setupLine + 1; i < lines.length; i++) {
            const lineText = lines[i].text;
            const toks = tokenize(lineText);
            const top = stack[stack.length - 1];
            const w = firstWord(toks);

            if (!toks.length) { top.children.push({ kind: 'blank', line: i }); continue; }
            if (toks[0].kind === 'comment') { top.children.push({ kind: 'comment', line: i }); continue; }

            // rgroup и старые menu/bar содержат только строки add; иная строка закрывает блок неявно
            // (пример: SERVER_LIB/gcc/draw/bnpformatki.pmlfrm — rgroup без exit)
            // (внутри бывают продолжения атрибутов: `callback |…|`, `vertical` — они блок не закрывают)
            if (stack.length > 1 && isAddOnlyBlock(stack[stack.length - 1].owner)
                && (w === 'member' || (toks[1]?.kind === 'name' && !!parseGadgetLine(lineText, toks)))) {
                // конец неявно закрытого блока — его последняя строка с кодом (add …), иначе строка заголовка;
                // без этого перенос/удаление rgroup оставляли бы его строки add на старом месте
                const closed = stack.pop()!;
                const code = closed.children.filter(c => c.kind !== 'blank' && c.kind !== 'comment');
                if (closed.owner) closed.owner.endLine = code.length ? code[code.length - 1].line : closed.owner.line;
            }
            const topNow = stack[stack.length - 1];

            if (w === 'exit') {
                if (stack.length === 1) { doc.setupEndLine = i; break; }
                const closed = stack.pop()!;
                if (closed.owner) closed.owner.endLine = i;
                continue;
            }

            if (DEFINE_METHOD_RE.test(lineText)) {
                // E3D закрывает незакрытые блоки неявно (пример: LOCAL_LIB/aba/Forms/abaarealib.pmlfrm).
                // Последний exit, закрывший frame, на самом деле закрывал setup — восстанавливаем это.
                doc.warnings.push({ line: i, message: `Неявное закрытие ${stack.length} блок(ов) setup form перед define method` });
                doc.setupEndLine = undefined;
                doc.implicitEnd = i;
                break;
            }

            // Перенос строки: `... $` в конце — склеиваем для разбора
            let cont = 0; let joined = lineText; let jt = toks;
            while (isContinued(jt) && i + cont + 1 < lines.length) {
                const last = jt.filter(t => t.kind !== 'comment').pop()!;
                cont++;
                // `$` убираем, незакрытую строку продолжаем через перевод строки
                joined = last.kind === 'string' ? joined + '\n' + lines[i + cont].text : joined.slice(0, last.start) + ' ' + lines[i + cont].text;
                jt = tokenize(joined);
            }
            const g = parseGadgetLine(joined, jt);
            if (g) {
                const node: GadgetNode = { kind: 'gadget', line: i, gadget: g };
                if (cont) { node.continuation = cont; i += cont; }
                if (cond > 0) node.conditional = true;
                if (cont) node.readOnly = 'Гаджет записан в несколько строк — правка только в коде';
                else if (!g.name || !/^[A-Za-z]\w*$/.test(g.name)) node.readOnly = 'Имя гаджета задано макросом или не указано — правка только в коде';
                topNow.children.push(node);
                // frame, view и старый rgroup открывают блок до exit
                if (g.type === 'frame' || g.type === 'rgroup' || g.type === 'view') {
                    node.children = [];
                    stack.push({ children: node.children, owner: node });
                }
                continue;
            }

            // menu/bar старой записи: строки `add …` до exit. В PML2 (`!this.m.add(...)`) exit нет.
            if ((w === 'menu' || w === 'bar') && nextCodeWord(lines, i) === 'add') {
                const name = toks[1]?.kind === 'name' ? toks[1].text.slice(1) : '';
                const node: BlockNode = { kind: 'block', line: i, keyword: w, name, children: [] };
                topNow.children.push(node);
                stack.push({ children: node.children, owner: node });
                continue;
            }

            if (kw(w, 'path', 4) || kw(w, 'hdistance', 4) || kw(w, 'vdistance', 4) || kw(w, 'halign', 4) || kw(w, 'valign', 4)) {
                const command = (kw(w, 'path', 4) ? 'path' : kw(w, 'hdistance', 4) ? 'hdist' : kw(w, 'vdistance', 4) ? 'vdist'
                    : kw(w, 'halign', 4) ? 'halign' : 'valign') as LayoutNode['command'];
                const value = toks.slice(1).filter(t => t.kind !== 'comment').map(t => t.text).join(' ');
                topNow.children.push({ kind: 'layout', line: i, command, value });
                continue;
            }

            if (w === 'member' && toks[1]?.kind === 'name') {
                const isIdx = toks.findIndex(t => t.kind === 'word' && t.text.toLowerCase() === 'is');
                topNow.children.push({
                    kind: 'member', line: i, name: toks[1].text.slice(1),
                    type: isIdx > 0 ? toks.slice(isIdx + 1).filter(t => t.kind !== 'comment').map(t => t.text).join(' ') : '',
                });
                continue;
            }

            if ((w === 'if' || w === 'do') && !/\b(endif|enddo)\b/i.test(lineText)) cond++;
            else if ((w === 'endif' || w === 'enddo') && cond > 0) cond--;
            topNow.children.push({ kind: 'statement', line: i, keyword: w || toks[0].text });
        }
        if (doc.setupEndLine === undefined && doc.implicitEnd === undefined) {
            doc.problems.push({ line: doc.setupLine, message: 'Не найден exit блока setup form' });
        }
        if (stack.length > 1 && doc.setupEndLine !== undefined) {
            doc.problems.push({ line: doc.setupEndLine, message: 'Незакрытый frame/menu/bar внутри setup form' });
        }
    }

    // 3. Методы и callback, назначенные в коде
    let cur: MethodInfo | undefined;
    for (i = (doc.setupEndLine ?? doc.implicitEnd ?? 0); i < lines.length; i++) {
        const t = lines[i].text;
        const dm = DEFINE_METHOD_RE.exec(t);
        if (dm) { cur = { name: dm[1], line: i, endLine: i }; doc.methods.push(cur); continue; }
        if (cur && ENDMETHOD_RE.test(t)) { cur.endLine = i; cur = undefined; continue; }
        const cb = CB_ASSIGN_RE.exec(t);
        if (cb) doc.callbackAssigns.push({ gadget: cb[1], value: cb[2].slice(1, -1), line: i, method: cur?.name });
    }
    return doc;
}

/** Обход всех гаджетов дерева в порядке определения. */
export function* walkGadgets(nodes: FormNode[], parent?: GadgetNode): Generator<{ node: GadgetNode; parent?: GadgetNode }> {
    for (const n of nodes) {
        if (n.kind === 'gadget') {
            yield { node: n, parent };
            if (n.children) yield* walkGadgets(n.children, n);
        } else if (n.kind === 'block') {
            yield* walkGadgets(n.children, parent);
        }
    }
}
