// Локализация: русский и английский. Строки пишутся парой прямо в коде — L('по-русски', 'in English').
// Язык задаёт расширение (настройка pmlFormDesigner.language / язык VS Code); по умолчанию — русский (тесты ядра).

export type Lang = 'ru' | 'en';

let lang: Lang = 'ru';

export const setLang = (l: Lang) => { lang = l; };
export const getLang = (): Lang => lang;

/** Текст на текущем языке. */
export const L = (ru: string, en: string): string => (lang === 'ru' ? ru : en);
