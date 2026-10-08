// Шаблон новой формы по правилам проекта (kb/rules/PML_RULES.md):
// A1 — UTF-8 с BOM (пишет вызывающий), A2 — имя файла = имя формы в нижнем регистре, A3 — префикс команды (настройка),
// B1 — `setup form !!bnpxxx dialog [docking right|left]`, B2 — шапка файла и блоки описания методов,
// B4 — отступ 4 пробела, B5 — конструктор минимальный, инициализация и callbacks — в .init() через !this.initCall.

import { L } from './i18n';

export type FormKind = 'dialog' | 'dialog docking right' | 'dialog docking left' | 'document';
export type FormTemplate = 'empty' | 'applyClose';

export interface NewFormOptions {
    name: string;            // без !!, напр. bnpMyForm
    kind: FormKind;
    resize: boolean;
    title: string;           // заголовок окна (formTitle)
    description?: string;    // для шапки; по умолчанию — заголовок
    developer: string;
    date: string;            // YYYY-MM-DD
    template: FormTemplate;
}

const IND = '    ';
const RULE = '------------------------------------------------------------------------';

/** Проверка имени формы: null — ок, иначе текст ошибки. Предупреждение о префиксе — отдельно (formNameWarning). */
export function validateFormName(name: string): string | null {
    if (!name) return L('Введите имя формы', 'Enter the form name');
    if (name.startsWith('!!')) return L('Без !! — только имя, напр. bnpMyForm', 'Without !! — just the name, e.g. myForm');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return L('Имя: латинские буквы, цифры, _; начинается с буквы', 'Name: Latin letters, digits, _; must start with a letter');
    if (/^cd/i.test(name)) return L('Префикс CD зарезервирован AVEVA (правило A3)', 'The CD prefix is reserved by AVEVA');
    return null;
}

/** Предупреждение, если имя не начинается с префикса команды (настройка formNamePrefix; пусто — не проверять). */
export function formNameWarning(name: string, prefix: string): string | null {
    if (!prefix) return null;
    return name.toLowerCase().startsWith(prefix.toLowerCase()) ? null : L(`Нет префикса ${prefix} (правило A3)`, `Name does not start with the prefix ${prefix}`);
}

export const formFileName = (name: string) => `${name.toLowerCase()}.pmlfrm`;

/** Строка PML: |…| (B3), если внутри есть | — '…'. */
const q = (s: string) => (s.includes('|') ? `'${s.split("'").join("''")}'` : `|${s}|`);

function methodBlock(name: string, description: string, body: string[]): string[] {
    return [
        RULE,
        '--',
        `-- Method:      ${name}`,
        `-- Description: ${description}`,
        '-- Method Type: Define',
        '-- Arguments:   none',
        '-- Return:      none',
        '--',
        RULE,
        `define method .${name}()`,
        ...body.map(l => IND + l),
        'endmethod',
        '',
    ];
}

/** Текст новой формы (концы строк — CRLF, как в проекте). */
export function newFormText(o: NewFormOptions): string {
    const file = formFileName(o.name);
    const attrs = [o.kind, o.resize ? 'resize' : ''].filter(Boolean).join(' ');
    const lines: string[] = [
        RULE,
        `-- File:        ${file}`,
        '-- Type:        Form',
        `-- Date:        ${o.date}`,
        `-- Developer:   ${o.developer}`,
        `-- Description: ${o.description || o.title}`,
        `-- show !!${o.name} / pml reload form !!${o.name}`,
        RULE,
        '',
        `setup form !!${o.name} ${attrs}`,
        `${IND}!this.formTitle = ${q(o.title)}`,
        `${IND}!this.initCall  = |!this.init()|`,
        '',
    ];
    if (o.template === 'applyClose') {
        lines.push(
            `${IND}button .bnApply ${q(L('Применить', 'Apply'))} at x0 y0 wid 12`,
            `${IND}button .bnClose ${q(L('Закрыть', 'Close'))} at xmax .bnApply + 1 ymin .bnApply wid 12`,
        );
    }
    lines.push('exit', '');
    lines.push(...methodBlock(o.name, L('Конструктор (минимальный — инициализация в .init())', 'Constructor (minimal — initialisation in .init())'), []));
    const init = o.template === 'applyClose'
        ? ['!this.bnApply.callback = |!this.apply()|', '!this.bnClose.callback = |!this.hide()|']
        : [];
    lines.push(...methodBlock('init', L('Инициализация формы: callbacks, заполнение гаджетов', 'Form initialisation: callbacks, filling gadgets'), init));
    if (o.template === 'applyClose') lines.push(...methodBlock('apply', L('Кнопка «Применить»', 'Apply button'), []));
    return lines.join('\r\n');
}
