// Сквозная проверка webview в Edge (puppeteer-core): node out/test/e2e/run.js [папка-для-скриншотов]
// Реальные действия мышью/клавиатурой → операции → текст формы. Хост — host.ts (без VS Code).

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert/strict';
import { buildSync } from 'esbuild';
import puppeteer, { Page } from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = path.join(__dirname, '..', '..', '..');
const shotsDir = process.argv[2];

const FORM = [
    'setup form !!demo dialog',
    '    !this.formTitle = |Демо|',
    '    !this.initCall = |!this.init()|',
    '    path down',
    '    button .ok |OK| at x0 y0 wid 12',
    '    button .cancel |Отмена| at x0 ymax .ok + 0.5 wid 12',
    '    frame .fr |Рамка| at x0 ymax .cancel + 0.5 wid 30 hei 6',
    '        list .lst |Список| at x0 y0 wid 20 hei 4',
    '    exit',
    'exit',
    '',
    'define method .init()',
    'endmethod',
    '',
].join('\r\n');

function html(): string {
    const host = buildSync({ entryPoints: [path.join(root, 'src/test/e2e/host.ts')], bundle: true, write: false, format: 'iife', platform: 'browser' }).outputFiles[0].text;
    const css = fs.readFileSync(path.join(root, 'media/designer.css'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'media/designer.js'), 'utf8');
    const ext = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
    // разметка — та же, что в shellHtml() расширения
    const body = /<body>([\s\S]*?)<script nonce/.exec(ext)![1];
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
:root{--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#333;
--vscode-editorWidget-background:#252526;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;--vscode-list-activeSelectionForeground:#fff;
--vscode-editorWarning-foreground:#cca700;--vscode-editorError-foreground:#f14c4c;--vscode-textLink-foreground:#3794ff;--vscode-textCodeBlock-background:#2d2d2d;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-editor-font-family:Consolas;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc}
${css}</style></head><body>${body}
<script>window.__text = ${JSON.stringify(FORM)};</script>
<script>${host}</script>
<script>${js}</script></body></html>`;
}

const text = (p: Page) => p.evaluate(() => window.__text);
const center = async (p: Page, sel: string) => {
    const b = await (await p.$(sel))!.boundingBox();
    return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2, b: b! };
};
/** Ввести значение в поле свойства: выделить всё, напечатать, Enter. */
const fill = async (p: Page, prop: string, value: string) => {
    const sel = `#props input[data-prop="${prop}"]`;
    await p.click(sel);
    await p.$eval(sel, el => (el as HTMLInputElement).select());
    await p.keyboard.type(value);
    const before = await p.evaluate(() => window.__text);
    await p.keyboard.press('Enter');
    await p.waitForFunction(b => window.__text !== b, { timeout: 2000 }, before);
    await new Promise(r => setTimeout(r, 50));   // перерисовка webview
};
/** Выбрать гаджет щелчком в дереве (на холсте центр frame может быть закрыт вложенными гаджетами). */
const pickInTree = async (p: Page, name: string) => {
    const line = await p.evaluate(n => (window as any).__lineOf(n), name);
    await p.click(`#tree .row[data-line="${line}"]`);
    await new Promise(r => setTimeout(r, 30));
};
const gadgetSel = async (p: Page, name: string) => {
    const line = await p.evaluate(n => (window as any).__lineOf(n), name);
    return `#canvas .g[data-line="${line}"]`;
};

async function main() {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    const consoleErrors: string[] = [];
    page.on('pageerror', e => consoleErrors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.setContent(html());
    await page.evaluate(() => {
        (window as any).__lineOf = (name: string) => window.__text.split(/\r?\n/).findIndex(l => new RegExp(`^\\s*\\w+\\s+\\.${name}\\b`).test(l));
    });
    await page.waitForSelector('#canvas .g');
    // после каждого действия ждать, пока webview получит новую раскладку (флаг pending в designer.js),
    // иначе тест действует быстрее человека и упирается в защиту от устаревших координат
    const settle = () => page.waitForFunction(() => !(window as any).__pmlDesigner.pending, { timeout: 3000 });
    const m = page.mouse as any, k = page.keyboard as any;
    for (const [obj, fn] of [[m, 'up'], [m, 'click'], [k, 'press']] as const) {
        const orig = obj[fn].bind(obj);
        obj[fn] = async (...a: unknown[]) => { await orig(...a); await new Promise(r => setTimeout(r, 0)); await settle(); };
    }
    const origClick = page.click.bind(page);
    (page as any).click = async (...a: Parameters<Page['click']>) => { await origClick(...a); await new Promise(r => setTimeout(r, 0)); await settle(); };
    const results: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
        try { await fn(); results.push(`✔ ${name}`); }
        catch (e) { results.push(`✘ ${name}: ${(e as Error).message.split('\n').slice(0, 6).join(' | ')}`); }
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `e2e_${results.length}.png`) as `${string}.png` });
    };

    await step('перетаскивание .ok вправо (abs) — остаётся abs; .cancel (ymax .ok) не трогается', async () => {
        const c = await center(page, await gadgetSel(page, 'ok'));
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        await page.mouse.move(c.x + 15, c.y + 1, { steps: 5 });
        await page.mouse.move(c.x + 30, c.y + 1, { steps: 5 });
        await page.mouse.up();
        const t = await text(page);
        assert.match(t, /\r\n    button \.ok \|OK\| at x4 y0 wid 12\r\n    button \.cancel \|Отмена\| at x0 ymax \.ok \+ 0\.5 wid 12\r\n/, t.split('\r\n').slice(4, 6).join(' | '));
    });

    await step('стрелка вправо (Shift ×4) сдвигает выделенный гаджет', async () => {
        await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
        const t = await text(page);
        assert.match(t, /button \.ok \|OK\| at x6 y0 wid 12/, t.split('\r\n')[4]);
    });

    await step('относительная позиция: .cancel стрелкой вниз меняет только смещение', async () => {
        await page.click(await gadgetSel(page, 'cancel'));
        await page.keyboard.press('ArrowDown');
        const t = await text(page);
        assert.match(t, /button \.cancel \|Отмена\| at x0 ymax \.ok \+ 0\.75 wid 12/, t.split('\r\n')[5]);
    });

    await step('перемещение .ok вниз не двигает привязанный .cancel (как WinForms)', async () => {
        const before = await page.$eval(await gadgetSel(page, 'cancel'), el => (el as HTMLElement).style.top);
        await pickInTree(page, 'ok');
        await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift');
        const after = await page.$eval(await gadgetSel(page, 'cancel'), el => (el as HTMLElement).style.top);
        assert.equal(after, before, '.cancel остался на месте');
        const t = await text(page);
        assert.match(t, /button \.ok \|OK\| at x6 y1 wid 12/, t.split('\r\n')[4]);
        // вернуть .ok наверх (стрелкой) — .cancel снова не двигается
        await page.keyboard.down('Shift'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Shift');
        assert.match(await text(page), /button \.ok \|OK\| at x6 y0 wid 12/);
    });

    await step('маркер размера: ширина .ok', async () => {
        await page.click(await gadgetSel(page, 'ok'));
        const h = await center(page, `${await gadgetSel(page, 'ok')} .h-e`);
        await page.mouse.move(h.x, h.y); await page.mouse.down();
        await page.mouse.move(h.x + 40, h.y, { steps: 5 }); await page.mouse.up();
        const t = await text(page);
        assert.match(t, /button \.ok \|OK\| at x6 y0 wid 17(\.5)?\r\n/, t.split('\r\n')[4]);
    });

    await step('панель элементов: button щелчком в frame → строка внутри frame, rel от .lst', async () => {
        await page.click('.tool[data-type="button"]');
        const fr = await center(page, await gadgetSel(page, 'fr'));
        const lst = await center(page, await gadgetSel(page, 'lst'));
        await page.mouse.click(lst.b.x + 2, lst.b.y + lst.b.height + 14);
        const lines = (await text(page)).split('\r\n');
        const i = lines.findIndex(l => /button \.button1/.test(l));
        assert.ok(i > 7 && /^\s+exit/.test(lines[i + 1]), `строка ${i}: ${lines[i]} / след.: ${lines[i + 1]} (frame ${JSON.stringify(fr.b)})`);
        assert.match(lines[i], /^        button \.button1 \|Кнопка\| at xmin \.lst( [+-] [\d.]+)? ymax \.lst( [+-] [\d.]+)? wid 10$/);
    });

    await step('панель элементов: tabset перетаскиванием (drag&drop) на форму', async () => {
        const body = await center(page, '#formBody');
        await page.evaluate((x, y) => {
            const dt = new DataTransfer();
            dt.setData('text/x-pml-gadget', 'tabset');
            const target = document.elementFromPoint(x, y)!;
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
        }, body.b.x + body.b.width - 30, body.b.y + body.b.height - 15);
        const t = await text(page);
        assert.match(t, /frame \.tabset1 tabset at .* wid 30 hei 8\r\n\s+frame \.tabset1Page1 \|Страница 1\|\r\n\s+exit\r\n\s+exit/);
    });

    await step('вкладка «+» добавляет страницу', async () => {
        await page.click('.tab.add');
        assert.match(await text(page), /frame \.tabset1Page2 \|Страница 2\|/);
    });

    await step('свойства: ширина list = 25 (Enter), имя .lst → .items (ссылки обновлены)', async () => {
        await page.click(await gadgetSel(page, 'lst'));
        await fill(page, 'width', '25');
        let t = await text(page);
        assert.match(t, /list \.lst \|Список\| at x0 y0 wid 25 hei 4/);
        await fill(page, 'name', 'items');
        t = await text(page);
        assert.match(t, /list \.items \|Список\|/);
        assert.match(t, /button \.button1 \|Кнопка\| at xmin \.items/);
        assert.ok(!/\.lst\b/.test(t));
    });

    await step('свойства: multiple, tooltip; переключатель Абс.', async () => {
        await page.click('#props input[data-flag="multiple"]');
        await new Promise(r => setTimeout(r, 50));
        await fill(page, 'tooltip', 'Подсказка');
        await page.click('#props [data-setmode="rel"]');
        await new Promise(r => setTimeout(r, 50));
        const relLine = (await text(page)).split('\r\n').find(l => /list \.items/.test(l))!;
        assert.match(relLine, /at x0 y0/, 'первый в frame: rel без предыдущего гаджета остаётся abs');
        await page.click('#props [data-setmode="abs"]');
        await new Promise(r => setTimeout(r, 50));
        const line = (await text(page)).split('\r\n').find(l => /list \.items/.test(l))!;
        // граф LIST (Справочник 12.1): MULTIple — после общих опций (at, tooltip), перед размером
        assert.equal(line.trim(), 'list .items |Список| at x0 y0 tooltip |Подсказка| multiple wid 25 hei 4');
    });

    await step('двойной щелчок: callback в .init() (B5) и заглушка метода', async () => {
        const c = await center(page, await gadgetSel(page, 'ok'));
        await page.mouse.click(c.x, c.y, { count: 2 });
        const t = await text(page);
        assert.match(t, /define method \.init\(\)\r\n    !this\.ok\.callback = \|!this\.okCallback\(\)\|\r\nendmethod/);
        assert.match(t, /define method \.okCallback\(\)\r\nendmethod/);
    });

    await step('поле Callback: новое имя → метод okCallback переименован в okPressed (без правки текста)', async () => {
        await pickInTree(page, 'ok');
        await fill(page, 'callback', '!this.okPressed()');
        const t = await text(page);
        assert.ok(t.includes('define method .okPressed()'), t);
        assert.ok(t.includes('!this.ok.callback = |!this.okPressed()|'), t);
        assert.ok(!t.includes('okCallback'), t);
    });

    await step('Del удаляет выделенный гаджет (.button1)', async () => {
        await page.click(await gadgetSel(page, 'button1'));
        await page.keyboard.press('Delete');
        assert.ok(!/button1/.test(await text(page)));
    });

    await step('перенос мышью: .cancel в frame .fr — подтверждение, .fr (ymax .cancel) → абс., строка внутри frame', async () => {
        const c = await center(page, await gadgetSel(page, 'cancel'));
        const it = await center(page, await gadgetSel(page, 'items'));
        await page.mouse.move(c.x, c.y); await page.mouse.down();
        const tx = it.b.x + 20, ty = it.b.y + it.b.height + 20;
        await page.mouse.move((c.x + tx) / 2, (c.y + ty) / 2, { steps: 5 });
        await page.mouse.move(tx, ty, { steps: 5 });
        const highlighted = await page.$eval('.drop-target', el => (el as HTMLElement).dataset.line);
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 50));
        const confirms = await page.evaluate(() => window.__log.filter((m: any) => m.confirm).map((m: any) => m.confirm));
        assert.match(confirms.join(' '), /От \.cancel позиционируются \.fr/);
        const L = (await text(page)).split('\r\n');
        const i = L.findIndex(l => /button \.cancel/.test(l));
        assert.ok(highlighted !== undefined, 'нет подсветки цели');
        // .cancel к этому шагу абсолютный (его «отвязал» шаг «перемещение .ok вниз…») → во frame он тоже абсолютный
        assert.match(L[i], /^        button \.cancel \|Отмена\| at (x[\d.]+ y[\d.]+|xmin \.items( [+-] [\d.]+)? ymax \.items( [+-] [\d.]+)?) wid 12$/, L[i]);
        assert.match(L[i - 1], /list \.items/);
        assert.match(L[i + 1], /^    exit$/);
        assert.ok(L.some(l => /^    frame \.fr \|Рамка\| at x0 y[\d.]+ wid 30 hei 6$/.test(l)), L.join('\n'));
    });

    await step('перенос мышью: frame .fr с содержимым на страницу tabset (tabset → абс., отступы)', async () => {
        const fr = await center(page, await gadgetSel(page, 'fr'));
        const tb = await center(page, '.tabbody');
        await page.mouse.move(fr.b.x + 30, fr.b.y + 4); await page.mouse.down();
        await page.mouse.move(tb.b.x + 30, tb.b.y + 10, { steps: 8 });
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 50));
        const t = await text(page);
        assert.match(t, /frame \.tabset1 tabset at x[\d.]+ y[\d.]+ wid 30 hei 8/);
        assert.match(t, /        frame \.tabset1Page2 \|Страница 2\|\r\n            frame \.fr \|Рамка\| at x[\d.]+ y[\d.]+ wid 30 hei 6\r\n                list \.items .*\r\n                button \.cancel .*\r\n            exit\r\n        exit/, t);
        assert.ok(!/at x-/.test(t), 'отрицательных координат нет');
    });

    await step('вкладка tabset → щелчок по гаджету на странице выделяет гаджет (не страницу); Alt+щелчок — контейнер под ним', async () => {
        const selected = () => page.evaluate(() => document.querySelector('#props h4')?.textContent ?? '');
        await page.click('.tab[data-tabset="tabset1"][data-page="1"]');
        assert.match(await selected(), /frame \.tabset1Page2/);
        const it = await center(page, await gadgetSel(page, 'items'));
        await page.mouse.click(it.b.x + 6, it.b.y + it.b.height - 6);
        assert.match(await selected(), /list \.items/, 'после выбора страницы гаджет на ней должен выделяться');
        await page.keyboard.down('Alt');
        await page.mouse.click(it.b.x + 6, it.b.y + it.b.height - 6);
        await page.keyboard.up('Alt');
        assert.match(await selected(), /frame \.fr/, 'Alt+щелчок — следующий элемент под курсором');
    });

    await step('ошибок в консоли нет', async () => {
        const errs = await page.evaluate(() => window.__errors);
        assert.deepEqual(consoleErrors, []);
        assert.deepEqual(errs, []);
    });

    console.log(results.join('\n'));
    console.log('\n--- итоговый текст ---\n' + (await text(page)));
    if (shotsDir) fs.writeFileSync(path.join(shotsDir, 'e2e_result.pmlfrm'), await text(page), 'utf8');
    await browser.close();
    if (results.some(r => r.startsWith('✘'))) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
