// Кодировки .pmlfrm. Логика перенесена из C:\Csharp\CP1251toUTF8 (EncodingConverter.cs):
// cp1251 читается строго (недопустимый байт — ошибка), запись — всегда UTF-8 с BOM (решение 2026-10-07).

export type FileEncoding = 'utf8bom' | 'utf8' | 'cp1251';

// Символы cp1251 для байтов 0x80..0xFF; 0x98 в cp1251 не определён.
const CP1251_HIGH =
    '\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F' +
    '\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\uFFFF\u2122\u0459\u203A\u045A\u045C\u045B\u045F' +
    '\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407' +
    '\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457';

function cp1251Char(b: number): string {
    if (b < 0x80) return String.fromCharCode(b);
    if (b >= 0xC0) return String.fromCharCode(0x0410 + (b - 0xC0)); // А..я
    const ch = CP1251_HIGH[b - 0x80];
    if (ch === '\uFFFF') throw new Error(`Байт 0x${b.toString(16)} недопустим в cp1251`);
    return ch;
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
    return bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
}

export function decodeCp1251(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += cp1251Char(b);
    return s;
}

/** Определяет кодировку и декодирует файл. Порядок: BOM → строгий UTF-8 → cp1251. */
export function decodeFile(bytes: Uint8Array): { text: string; encoding: FileEncoding } {
    if (hasUtf8Bom(bytes)) {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)), encoding: 'utf8bom' };
    }
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' };
    } catch {
        return { text: decodeCp1251(bytes), encoding: 'cp1251' };
    }
}

/** Текст → байты UTF-8 с BOM. */
export function encodeUtf8Bom(text: string): Uint8Array {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xEF, 0xBB, 0xBF], 0);
    out.set(body, 3);
    return out;
}
