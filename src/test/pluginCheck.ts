// Проверка правок дизайнера расширением pml-aveva-e3d (CLI diagnose).
// node out/test/pluginCheck.js <папка> [<папка>…] [--limit N]
// Для каждой формы: исходник и копия с правками всех гаджетов (позиция, размер, tag, callback, tooltip,
// затем переименование button) → diagnose обоих → новые диагностики в копии = ошибка дизайнера.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { decodeFile } from '../core/encoding';
import { parseForm, printLines, walkGadgets, GadgetNode } from '../core/form';
import { Edit, applyEdits, setPosition, setSize, setTag, setCallback, setTooltip, renameGadget, addMethodStub } from '../core/edits';

function findCli(): string {
    const base = path.join(os.homedir(), '.vscode', 'extensions');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('mikhalchankasm.pml-aveva-e3d-')).sort();
    if (!dirs.length) throw new Error('Не найдено расширение mikhalchankasm.pml-aveva-e3d');
    return path.join(base, dirs[dirs.length - 1], 'packages', 'pml-language-server', 'out', 'cli.js');
}

function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.name.toLowerCase().endsWith('.pmlfrm')) yield p;
    }
}

interface Diag { line: number; code: string; message: string }

function diagnose(cli: string, file: string): Diag[] {
    const r = spawnSync('node', [cli, 'diagnose', file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const json = JSON.parse(r.stdout);
    return json.diagnostics.map((d: any) => ({ line: d.range.start.line, code: String(d.code ?? ''), message: d.message }));
}

const PRIORITY = new Set(['frame', 'button', 'list', 'option', 'textpane']);

/** Правки первого прохода: каждая меняет реальное значение. */
function designerEdits(node: GadgetNode): Edit[] {
    const g = node.gadget;
    const out: Edit[] = [];
    if (g.at && (!g.at.x || g.at.x.exact) && (!g.at.y || g.at.y.exact)) {
        const sh = (c?: typeof g.at.x) => c && { ...c, value: c.value + (c.mode === 'abs' ? 1 : 0.5) };
        out.push(setPosition(node, sh(g.at.x), sh(g.at.y)));
    }
    if (!PRIORITY.has(g.type)) return out;
    if (g.width?.mode === 'abs') out.push(setSize(node, 'width', { ...g.width, value: (g.width.value ?? 0) + 1 }));
    if (g.type !== 'frame' || g.tag !== undefined) out.push(setTag(node, 'Тест ' + g.name));
    if (g.type === 'button' || g.type === 'list' || g.type === 'option') out.push(setCallback(node, `!this.${g.name}Cb()`));
    if (g.type === 'button') out.push(setTooltip(node, 'Подсказка'));
    return out;
}

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li >= 0 ? parseInt(args[li + 1], 10) : Infinity;
const opt = (k: string) => { const j = args.indexOf(k); return j >= 0 ? args[j + 1] : undefined; };
const only = opt('--only');      // подстрока пути: проверять только такие файлы
const dump = opt('--dump');      // папка: сохранить исходник и копию с правками
const roots = args.filter((a, i) => !a.startsWith('--') && !['--limit', '--only', '--dump'].includes(args[i - 1]));

const cli = findCli();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmlfd-'));
let files = 0, edited = 0, filesWithNew = 0;
const newByCode: Record<string, number> = {};
const examples: string[] = [];

for (const root of roots) for (const file of walk(root)) {
    if (files >= limit) break;
    if (only && !file.toLowerCase().includes(only.toLowerCase())) continue;
    const { text } = decodeFile(fs.readFileSync(file));
    const doc = parseForm(text);
    if (doc.setupLine === undefined) continue;
    files++;

    // Проход 1: позиция/размер/tag/callback/tooltip
    const edits: Edit[] = [];
    for (const { node } of walkGadgets(doc.nodes)) if (!node.readOnly) edits.push(...designerEdits(node));
    // заглушки методов для новых callback (как при двойном щелчке в дизайнере)
    for (const { node } of walkGadgets(doc.nodes)) {
        const g = node.gadget;
        if (!node.readOnly && (g.type === 'button' || g.type === 'list' || g.type === 'option')) {
            const st = addMethodStub(doc, `${g.name}Cb`);
            if (st) edits.push(st);
        }
    }
    let lines = applyEdits(doc.lines, edits);
    // Проход 2: переименование всех button (по свежему разбору)
    const doc2 = parseForm(printLines(lines));
    const ren: Edit[] = [];
    for (const { node } of walkGadgets(doc2.nodes)) {
        if (node.gadget.type === 'button' && !node.readOnly) ren.push(...renameGadget(doc2, node, node.gadget.name + 'Rn'));
    }
    lines = applyEdits(doc2.lines, ren);
    edited += edits.length + ren.length;

    const base = path.join(tmp, `${files}`);
    fs.writeFileSync(base + '_a.pmlfrm', text, 'utf8');
    fs.writeFileSync(base + '_b.pmlfrm', printLines(lines), 'utf8');
    const a = diagnose(cli, base + '_a.pmlfrm');
    const b = diagnose(cli, base + '_b.pmlfrm');
    // сравнение мультимножеств (строка, код); сообщения содержат имена — для переименования сравниваем без них
    const key = (d: Diag) => `${d.line}|${d.code}`;
    const cnt = new Map<string, number>();
    for (const d of a) cnt.set(key(d), (cnt.get(key(d)) ?? 0) + 1);
    let any = false;
    for (const d of b) {
        const k = key(d);
        const c = cnt.get(k) ?? 0;
        if (c > 0) { cnt.set(k, c - 1); continue; }
        any = true;
        newByCode[d.code] = (newByCode[d.code] ?? 0) + 1;
        if (examples.length < 25) examples.push(`${file}:${d.line + 1} ${d.code} ${d.message}\n      было:  ${doc.lines[d.line]?.text.trim()}\n      стало: ${lines[d.line]?.text.trim()}`);
    }
    if (any) filesWithNew++;
    if (dump) {
        fs.mkdirSync(dump, { recursive: true });
        fs.copyFileSync(base + '_a.pmlfrm', path.join(dump, path.basename(file, '.pmlfrm') + '_a.pmlfrm'));
        fs.copyFileSync(base + '_b.pmlfrm', path.join(dump, path.basename(file, '.pmlfrm') + '_b.pmlfrm'));
    }
    fs.rmSync(base + '_a.pmlfrm'); fs.rmSync(base + '_b.pmlfrm');
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(JSON.stringify({ files, edits: edited, filesWithNewDiagnostics: filesWithNew, newByCode }, null, 1));
for (const e of examples) console.log('  ' + e);
