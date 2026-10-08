// Перенос гаджетов между контейнерами на реальных формах + проверка расширением pml-aveva-e3d.
// node out/test/reparentCheck.js <папки> [--limit N]
// Для каждой формы: каждый гаджет формы (не frame) переносится в первый подходящий frame (если операция разрешена),
// и каждый гаджет первого frame — на форму; новые диагностики расширения = ошибка переноса.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { decodeFile } from '../core/encoding';
import { parseForm, printLines, walkGadgets } from '../core/form';
import { applyEdits } from '../core/edits';
import { execute } from '../core/operations';

function findCli(): string {
    const base = path.join(os.homedir(), '.vscode', 'extensions');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('mikhalchankasm.pml-aveva-e3d-')).sort();
    return path.join(base, dirs[dirs.length - 1], 'packages', 'pml-language-server', 'out', 'cli.js');
}
function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p); else if (e.name.toLowerCase().endsWith('.pmlfrm')) yield p;
    }
}
const diag = (cli: string, f: string) => JSON.parse(spawnSync('node', [cli, 'diagnose', f, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout)
    .diagnostics.map((d: any) => `${d.code}|${d.message.replace(/'[^']*'/g, "''")}`) as string[];

/** `view .x … exit` → `paragraph .x text |view|` + пустые строки (нумерация строк сохраняется). */
function stripViews(text: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)view\s+(\.\w+)/i.exec(lines[i]);
        if (!m) { out.push(lines[i]); continue; }
        let j = i + 1;
        while (j < lines.length && !/^\s*exit\b/i.test(lines[j])) j++;
        out.push(`${m[1]}paragraph ${m[2]} text |view|`, ...Array(j - i).fill(''));
        i = j;
    }
    return out.join('\r\n');
}

let pluginCannotParse = 0;
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li >= 0 ? +args[li + 1] : Infinity;
const dj = args.indexOf('--dump');
const dump = dj >= 0 ? args[dj + 1] : undefined;
const only = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1].toLowerCase() : undefined;
const roots = args.filter((a, i) => !a.startsWith('--') && !['--limit', '--dump', '--only'].includes(args[i - 1]));
const cli = findCli();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmlrp-'));
let files = 0, moves = 0, refused = 0, bad = 0;
const reasons: Record<string, number> = {};
const examples: string[] = [];

for (const root of roots) for (const file of walk(root)) {
    if (files >= limit) break;
    if (only && !file.toLowerCase().includes(only)) continue;
    let text = decodeFile(fs.readFileSync(file)).text;
    const doc0 = parseForm(text);
    if (doc0.setupLine === undefined) continue;
    const frame = [...walkGadgets(doc0.nodes)].find(x => !x.parent && x.node.gadget.type === 'frame'
        && !x.node.gadget.flags.includes('tabset') && !x.node.readOnly)?.node;
    if (!frame) continue;
    files++;
    const orig = text;
    // 1) гаджеты формы → во frame; 2) гаджеты frame → на форму. Каждый раз по свежему разбору (строки сдвигаются).
    const plan: { name: string; toFrame: boolean }[] = [];
    for (const { node, parent } of walkGadgets(doc0.nodes)) {
        if (node.readOnly || !node.gadget.name || node === frame) continue;
        if (!parent && node.gadget.type !== 'frame') plan.push({ name: node.gadget.name, toFrame: true });
        if (parent === frame) plan.push({ name: node.gadget.name, toFrame: false });
    }
    for (const step of plan.slice(0, 12)) {
        const doc = parseForm(text);
        const all = [...walkGadgets(doc.nodes)];
        const g = all.find(x => x.node.gadget.name.toLowerCase() === step.name.toLowerCase())?.node;
        const fr = all.find(x => x.node.gadget.name.toLowerCase() === frame.gadget.name.toLowerCase())?.node;
        if (!g || !fr) continue;
        const r = execute(text, { op: 'reparent', line: g.line, parentLine: step.toFrame ? fr.line : null, x: 1, y: 1, defaultMode: 'rel', force: true });   // «Да» на подтверждение: ссылки вперёд → абс.
        if (r.error) { refused++; const k = r.error.replace(/\..*/, '').slice(0, 40); reasons[k] = (reasons[k] ?? 0) + 1; continue; }
        text = printLines(applyEdits(doc.lines, r.edits));
        moves++;
    }
    if (text === orig) continue;
    // структура не должна ломаться: тот же набор гаджетов
    const names = (t: string) => [...walkGadgets(parseForm(t).nodes)].map(x => x.node.gadget.name.toLowerCase()).sort().join(',');
    if (names(orig) !== names(text)) { bad++; examples.push(`${file}: изменился набор гаджетов`); continue; }
    const a = path.join(tmp, 'a.pmlfrm'), b = path.join(tmp, 'b.pmlfrm');
    // обход особенности pml-aveva-e3d 0.15: `view … exit` не считается блоком (exit view закрывает frame, следующий — setup),
    // и всё ниже него расширение видит «вне формы» → сравниваем тексты с view, заменённым однострочной заглушкой
    fs.writeFileSync(a, stripViews(orig), 'utf8'); fs.writeFileSync(b, stripViews(text), 'utf8');
    const da = diag(cli, a), db = diag(cli, b);
    if (da.some(d => d.startsWith('PML_PARSE_ERROR|'))) { pluginCannotParse++; continue; }   // расширение не разбирает исходник
    const cnt = new Map<string, number>();
    for (const d of da) cnt.set(d, (cnt.get(d) ?? 0) + 1);
    const extra = db.filter(d => { const c = cnt.get(d) ?? 0; if (c) { cnt.set(d, c - 1); return false; } return true; });
    if (extra.length) {
        bad++;
        if (examples.length < 15) examples.push(`${file}: ${extra.slice(0, 3).join(' ; ')}`);
        if (dump) { fs.mkdirSync(dump, { recursive: true }); fs.copyFileSync(a, path.join(dump, path.basename(file) + '.a')); fs.copyFileSync(b, path.join(dump, path.basename(file) + '.b')); }
    }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ files, moves, refused, pluginCannotParse, filesWithNewDiagnostics: bad, refusedBy: reasons }, null, 1));
for (const e of examples) console.log('  ' + e);
