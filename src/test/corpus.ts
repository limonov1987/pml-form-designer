// Прогон парсера по всем формам: node out/test/corpus.js <папка> [<папка>…]
// Проверки: печать без потерь; структура setup (exit найден); повторная генерация AT/WIDTH/HEIGHT
// из модели даёт ту же модель; статистика нераспознанных токенов по типам гаджетов.

import * as fs from 'fs';
import * as path from 'path';
import { decodeFile } from '../core/encoding';
import { parseForm, printLines, walkGadgets } from '../core/form';
import { parseGadgetLine, Coord, SizeSpec } from '../core/gadget';
import { setPosition, setSize, applyEdits } from '../core/edits';

const PRIORITY = new Set(['frame', 'button', 'list', 'option', 'textpane']); // tabset — это frame

function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.name.toLowerCase().endsWith('.pmlfrm')) yield p;
    }
}

const sameCoord = (a?: Coord, b?: Coord) =>
    (!a && !b) || (!!a && !!b && a.axis === b.axis && a.mode === b.mode && Math.abs(a.value - b.value) < 1e-9
        && (a.edge ?? '') === (b.edge ?? '') && (a.ref ?? '').toLowerCase() === (b.ref ?? '').toLowerCase()
        && !!a.minusSize === !!b.minusSize);
const sameSize = (a?: SizeSpec, b?: SizeSpec) =>
    (!a && !b) || (!!a && !!b && a.mode === b.mode && a.value === b.value && (a.ref ?? '').toLowerCase() === (b.ref ?? '').toLowerCase());

const stats = {
    files: 0, noSetup: 0, encodings: {} as Record<string, number>, lossy: 0, problems: 0,
    gadgets: {} as Record<string, number>, atExact: 0, atInexact: 0, atMulti: 0,
    regenAt: 0, regenAtFail: 0, regenSize: 0, regenSizeFail: 0,
};
const extras: Record<string, Record<string, number>> = {};
const examples: Record<string, string[]> = {};
const ex = (k: string, s: string) => { (examples[k] ??= []).length < 8 && examples[k].push(s); };

for (const root of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
    for (const file of walk(root)) {
        const bytes = fs.readFileSync(file);
        const { text, encoding } = decodeFile(bytes);
        const doc = parseForm(text);
        if (doc.setupLine === undefined) { stats.noSetup++; continue; }
        stats.files++;
        stats.encodings[encoding] = (stats.encodings[encoding] ?? 0) + 1;
        if (printLines(doc.lines) !== text) { stats.lossy++; ex('lossy', file); }
        if (doc.warnings.length) { (stats as any).implicitEnd = ((stats as any).implicitEnd ?? 0) + 1; }
        if (doc.problems.length) { stats.problems++; ex('problems', `${file}:${doc.problems[0].line + 1} ${doc.problems[0].message}`); }

        for (const { node } of walkGadgets(doc.nodes)) {
            const g = node.gadget;
            if (node.readOnly) { (stats as any).continued = ((stats as any).continued ?? 0) + 1; continue; }
            const key = g.type === 'frame' && g.flags.includes('tabset') ? 'frame(tabset)' : g.type;
            stats.gadgets[key] = (stats.gadgets[key] ?? 0) + 1;
            if (PRIORITY.has(g.type)) for (const e of g.extras) {
                const k = e.startsWith("'") || e.startsWith('|') ? '<string>' : e.toLowerCase();
                (extras[g.type] ??= {})[k] = (extras[g.type][k] ?? 0) + 1;
                if (extras[g.type][k] <= 2) ex(`extra ${g.type} ${k}`, `${path.basename(file)}:${node.line + 1}: ${doc.lines[node.line].text.trim()}`);
            }
            if (g.atCount > 1) stats.atMulti++;
            const at = g.at;
            if (at) {
                const exact = (!at.x || at.x.exact) && (!at.y || at.y.exact);
                if (!exact) { stats.atInexact++; ex('at inexact', doc.lines[node.line].text.trim()); continue; }
                stats.atExact++;
                // Перегенерация AT той же моделью → разбор → сравнение
                const lines = applyEdits(doc.lines, [setPosition(node, at.x, at.y)]);
                const g2 = parseGadgetLine(lines[node.line].text);
                stats.regenAt++;
                if (!g2 || !sameCoord(at.x, g2.at?.x) || !sameCoord(at.y, g2.at?.y) || g2.extras.length !== g.extras.length) {
                    stats.regenAtFail++;
                    ex('regen at fail', `${doc.lines[node.line].text.trim()}  =>  ${lines[node.line].text.trim()}`);
                }
            }
            for (const kind of ['width', 'height'] as const) {
                const s = g[kind];
                if (!s || s.mode === 'to' || s.mode === 'raw') continue;
                const lines = applyEdits(doc.lines, [setSize(node, kind, s)]);
                const g2 = parseGadgetLine(lines[node.line].text);
                stats.regenSize++;
                if (!g2 || !sameSize(s, g2[kind]) || g2.extras.length !== g.extras.length) {
                    stats.regenSizeFail++;
                    ex('regen size fail', `${doc.lines[node.line].text.trim()}  =>  ${lines[node.line].text.trim()}`);
                }
            }
        }
    }
}

console.log(JSON.stringify(stats, null, 1));
console.log('\n== Нераспознанные токены (приоритетные гаджеты), топ-15 по типу');
for (const [t, m] of Object.entries(extras)) {
    const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`${t}: ${top.map(([k, v]) => `${k}×${v}`).join(', ')}`);
}
const showKeys = Object.keys(examples).filter(k => !k.startsWith('extra ') || process.argv.includes('--extras'));
for (const k of showKeys) console.log(`\n== ${k}\n  ` + examples[k].join('\n  '));
