// Раскладка всех форм: без исключений и NaN. node out/test/layoutCorpus.js <папки>
import * as fs from 'fs';
import * as path from 'path';
import { decodeFile } from '../core/encoding';
import { parseForm } from '../core/form';
import { layoutForm } from '../core/layout';

function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p); else if (e.name.toLowerCase().endsWith('.pmlfrm')) yield p;
    }
}
const why: Record<string, number> = {}; const nf: string[] = []; const big: string[] = [];
let files = 0, gadgets = 0, approx = 0, bad = 0, maxW = 0, maxH = 0;
for (const root of process.argv.slice(2)) for (const f of walk(root)) {
    const doc = parseForm(decodeFile(fs.readFileSync(f)).text);
    if (doc.setupLine === undefined) continue;
    files++;
    try {
        const L = layoutForm(doc);
        for (const g of L.gadgets) {
            gadgets++; if (g.approx) { approx++; const k = g.approxWhy!.replace(/\.[\w$!<>]+|строка \d+|\$[!\w<>.]+/g, '…'); why[k] = (why[k] ?? 0) + 1; if (g.approxWhy!.startsWith('не найден') && nf.length < 12) nf.push(`${path.basename(f)}:${g.line + 1} ${g.approxWhy}  | ${doc.lines[g.line].text.trim().slice(0, 90)}`); }
            if (![g.box.x, g.box.y, g.box.w, g.box.h].every(Number.isFinite)) { bad++; if (bad < 5) console.log('NaN', f, g.name); }
        }
        if (L.width > 200 || L.height > 150) big.push(`${f} ${L.width.toFixed(0)}x${L.height.toFixed(0)}`);
        maxW = Math.max(maxW, L.width); maxH = Math.max(maxH, L.height);
    } catch (e) { bad++; console.log('ERR', f, (e as Error).message); }
}
console.log({ files, gadgets, approx, bad, maxW, maxH }, Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 15), big.length, big.slice(0, 10), nf);
