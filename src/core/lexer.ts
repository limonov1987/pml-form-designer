// Лексер одной строки PML. Каждый токен хранит смещения [start, end) в строке —
// на них опираются точечные правки (замена только нужного фрагмента строки).

export type TokenKind =
    | 'word'      // ключевые слова и идентификаторы: button, at, xmin, xmin.gad, x0, form
    | 'name'      // имя гаджета через точку: .gad
    | 'var'       // переменная: !this.x, !!form, !a
    | 'number'    // 12, 0.5, .25
    | 'string'    // 'текст', |текст| или "текст"
    | 'op'        // + - * / ( ) , = и прочие одиночные символы
    | 'macro'     // $!x, $!<x>, $(...), $p ...
    | 'comment';  // $* ... или -- ... до конца строки

export interface Token {
    kind: TokenKind;
    text: string;
    start: number;
    end: number;
    /** Строка без кавычек (для kind = 'string'). */
    value?: string;
    /** Для kind = 'string': нет закрывающей кавычки. */
    unterminated?: boolean;
}

const isWordStart = (c: string) => /[A-Za-z_À-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_À-￿]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function tokenize(line: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        const c = line[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        const start = i;

        // Комментарии
        if (c === '$' && line[i + 1] === '*') {
            out.push({ kind: 'comment', text: line.slice(i), start, end: n });
            break;
        }
        if (c === '-' && line[i + 1] === '-') {
            out.push({ kind: 'comment', text: line.slice(i), start, end: n });
            break;
        }

        // Строки
        if (c === "'" || c === '|' || c === '"') {
            let close = line.indexOf(c, i + 1);
            // '' внутри '...' — экранированная кавычка
            while (c === "'" && close >= 0 && line[close + 1] === "'") close = line.indexOf(c, close + 2);
            const end = close < 0 ? n : close + 1;
            out.push({
                kind: 'string', text: line.slice(start, end), start, end,
                value: line.slice(i + 1, close < 0 ? n : close), unterminated: close < 0,
            });
            i = end;
            continue;
        }

        // Макроподстановки $!x, $!<x>, $(...), $p и т. п.
        if (c === '$') {
            i++;
            if (line[i] === '!') {
                i++;
                if (line[i] === '!') i++;
                if (line[i] === '<') {
                    const close = line.indexOf('>', i);
                    i = close < 0 ? n : close + 1;
                } else {
                    while (i < n && (isWordChar(line[i]) || line[i] === '.')) i++;
                }
            } else if (line[i] === '(' || line[i] === ')') {
                i++;
            } else {
                while (i < n && isWordChar(line[i])) i++;
            }
            out.push({ kind: 'macro', text: line.slice(start, i), start, end: i });
            continue;
        }

        // Переменные !x, !!x, !this.a.b
        if (c === '!') {
            i++;
            if (line[i] === '!') i++;
            while (i < n && (isWordChar(line[i]) || line[i] === '.')) i++;
            out.push({ kind: 'var', text: line.slice(start, i), start, end: i });
            continue;
        }

        // Числа: 12, 0.5, .25
        if (isDigit(c) || (c === '.' && isDigit(line[i + 1] ?? ''))) {
            i++;
            while (i < n && (isDigit(line[i]) || line[i] === '.')) i++;
            // экспонента не встречается в разметке форм — не разбираем
            out.push({ kind: 'number', text: line.slice(start, i), start, end: i });
            continue;
        }

        // Имя гаджета .gad (в т. ч. .gad.sub); старая запись _gad в начале слова
        if ((c === '.' || (c === '_' && (out.length === 1))) && isWordStart(line[i + 1] ?? '') && line[i + 1] !== '_') {
            i++;
            while (i < n && (isWordChar(line[i]) || line[i] === '.')) i++;
            out.push({ kind: 'name', text: line.slice(start, i), start, end: i });
            continue;
        }

        // Слова: xmin.gad, x0, y1.5 — точка внутри слова допустима, если за ней буква/цифра
        if (isWordStart(c)) {
            i++;
            while (i < n) {
                if (isWordChar(line[i])) { i++; continue; }
                if (line[i] === '.' && i + 1 < n && (isWordChar(line[i + 1]))) { i++; continue; }
                break;
            }
            out.push({ kind: 'word', text: line.slice(start, i), start, end: i });
            continue;
        }

        out.push({ kind: 'op', text: c, start, end: i + 1 });
        i++;
    }
    return out;
}

/**
 * Сравнение с ключевым словом PML с учётом сокращений: слово совпадает,
 * если оно — префикс полного ключевого слова длиной не меньше minLen.
 */
export function kw(word: string, full: string, minLen = full.length): boolean {
    const w = word.toLowerCase();
    return w.length >= minLen && w.length <= full.length && full.startsWith(w);
}
