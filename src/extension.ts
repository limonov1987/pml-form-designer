// Расширение «PML Form Designer».
// Этап 3: редактирование — перемещение/размер/добавление/удаление/свойства/двойной щелчок (core/operations.ts),
// правки через WorkspaceEdit (undo/redo VS Code); холст, дерево, свойства, синхронное выделение, cp1251 → UTF-8 BOM.
// Источник правды — TextDocument: дизайнер перерисовывается при каждом изменении текста.

import * as vscode from 'vscode';
import { parseForm } from './core/form';
import { toViewModel, gadgetProps } from './core/viewModel';
import { layoutForm } from './core/layout';
import { decodeFile, encodeUtf8Bom, FileEncoding } from './core/encoding';
import { Edit, CodeStyle } from './core/edits';
import { execute, Request } from './core/operations';
import { newFormText, validateFormName, formNameWarning, formFileName, FormKind, FormTemplate } from './core/template';
import { L, setLang, getLang, Lang } from './core/i18n';
import * as os from 'os';

const VIEW_TYPE = 'pmlFormDesigner.editor';

/** Язык интерфейса: настройка pmlFormDesigner.language; auto — по языку VS Code (ru* → русский, иначе английский). */
function resolveLang(): Lang {
    const v = vscode.workspace.getConfiguration('pmlFormDesigner').get<string>('language', 'auto');
    if (v === 'ru' || v === 'en') return v;
    return vscode.env.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function activate(context: vscode.ExtensionContext) {
    setLang(resolveLang());
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('pmlFormDesigner.language')) setLang(resolveLang()); }),
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new FormDesignerProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('pmlFormDesigner.open', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (target) vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('pmlFormDesigner.newForm', (folder?: vscode.Uri) => newForm(folder)),
    );
}

export function deactivate() { /* нет ресурсов */ }

class FormDesignerProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
        panel.webview.html = shellHtml(panel.webview, media);

        let encoding: FileEncoding = 'utf8bom';
        const detectEncoding = async () => {
            try { encoding = decodeFile(await vscode.workspace.fs.readFile(document.uri)).encoding; } catch { /* новый файл */ }
        };
        await detectEncoding();

        // Перед первой правкой: cp1251 — только после конвертации; UTF-8 без BOM — предложить конвертацию (один раз)
        let askedUtf8 = false;
        const encodingGuard = async (): Promise<boolean> => {
            if (encoding === 'utf8bom') return true;
            if (encoding === 'cp1251') {
                const conv = L('Конвертировать', 'Convert');
                const a = await vscode.window.showWarningMessage(L('Файл в cp1251: правка в дизайнере испортит кириллицу. Сначала конвертируйте в UTF-8 с BOM.',
                    'The file is in cp1251: editing it in the designer would corrupt Cyrillic text. Convert it to UTF-8 with BOM first.'), conv);
                if (a === conv) await convertToUtf8Bom(document, () => detectEncoding().then(render));
                return false;
            }
            if (askedUtf8) return true;
            askedUtf8 = true;
            const conv = L('Конвертировать', 'Convert'), keep = L('Продолжить так', 'Continue as is');
            const a = await vscode.window.showInformationMessage(L('Файл в UTF-8 без BOM. Дизайнер сохраняет UTF-8 с BOM — конвертировать сейчас?',
                'The file is UTF-8 without BOM. The designer saves UTF-8 with BOM — convert now?'), conv, keep);
            if (a === conv) { await convertToUtf8Bom(document, () => detectEncoding().then(render)); return false; }
            return a === keep;
        };

        let timer: NodeJS.Timeout | undefined;
        const render = () => {
            const doc = parseForm(document.getText());
            panel.webview.postMessage({
                type: 'render', encoding, fileName: vscode.workspace.asRelativePath(document.uri),
                model: toViewModel(doc), layout: layoutForm(doc), props: gadgetProps(doc, settings().style),
            });
        };
        const renderSoon = () => { if (timer) clearTimeout(timer); timer = setTimeout(render, 150); };
        const isMine = (d: vscode.TextDocument) => d.uri.toString() === document.uri.toString();

        const subs = [
            vscode.workspace.onDidChangeTextDocument(e => { if (isMine(e.document)) renderSoon(); }),
            vscode.workspace.onDidSaveTextDocument(async d => { if (isMine(d)) { await detectEncoding(); render(); } }),
            // курсор в коде → выделение на холсте
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (isMine(e.textEditor.document)) panel.webview.postMessage({ type: 'cursor', line: e.selections[0].active.line });
            }),
            panel.webview.onDidReceiveMessage(async msg => {
                if (msg.type === 'ready') render();
                if (msg.type === 'op') {
                    if (!(await encodingGuard())) return;
                    await runOperation(document, msg.req as Request, name => panel.webview.postMessage({ type: 'selectName', name }));
                    // своя правка — перерисовать сразу (без задержки renderSoon), иначе холст ждёт с устаревшей раскладкой
                    if (timer) clearTimeout(timer);
                    render();
                }
                if (msg.type === 'reveal') revealLine(document, msg.line);
                if (msg.type === 'newForm') await newForm(vscode.Uri.joinPath(document.uri, '..'));
                if (msg.type === 'convertEncoding') await convertToUtf8Bom(document, () => detectEncoding().then(render));
            }),
        ];
        panel.onDidDispose(() => { if (timer) clearTimeout(timer); subs.forEach(s => s.dispose()); });
    }
}

/** Настройки: где назначать callback и стиль координат. */
/**
 * «PML: Новая форма»: имя → вид → заголовок → шаблон → файл <имя в нижнем регистре>.pmlfrm (UTF-8 BOM) → дизайнер.
 * Папка: из контекстного меню проводника; иначе настройка newFormFolder (относительно рабочей папки), иначе выбор папки.
 */
async function newForm(folder?: vscode.Uri) {
    const cfg = vscode.workspace.getConfiguration('pmlFormDesigner');
    const prefix = cfg.get<string>('formNamePrefix', '').trim();
    const name = await vscode.window.showInputBox({
        title: L('Новая форма PML (1/4): имя', 'New PML form (1/4): name'),
        prompt: prefix ? L(`Имя формы без !! (префикс ${prefix})`, `Form name without !! (prefix ${prefix})`) : L('Имя формы без !!', 'Form name without !!'), value: prefix,
        valueSelection: [prefix.length, prefix.length], validateInput: v => validateFormName(v.trim()),
    });
    if (!name) return;
    const warn = formNameWarning(name.trim(), prefix);
    const go = L('Продолжить', 'Continue');
    if (warn && (await vscode.window.showWarningMessage(warn, go, L('Отмена', 'Cancel'))) !== go) return;

    const kinds: { label: string; formKind: FormKind; resize: boolean; description: string }[] = [
        { label: 'dialog docking right', formKind: 'dialog docking right', resize: false, description: L('панель справа', 'panel docked right') },
        { label: 'dialog', formKind: 'dialog', resize: false, description: L('обычный диалог', 'plain dialog') },
        { label: 'dialog resize', formKind: 'dialog', resize: true, description: L('диалог с изменяемым размером', 'resizable dialog') },
        { label: 'dialog docking left', formKind: 'dialog docking left', resize: false, description: L('панель слева', 'panel docked left') },
        { label: 'document', formKind: 'document', resize: false, description: L('окно-документ', 'document window') },
    ];
    const kind = await vscode.window.showQuickPick(kinds, { title: L('Новая форма PML (2/4): вид окна', 'New PML form (2/4): window kind') });
    if (!kind) return;

    const title = await vscode.window.showInputBox({ title: L('Новая форма PML (3/4): заголовок окна', 'New PML form (3/4): window title'), prompt: '!this.formTitle', value: '' });
    if (title === undefined) return;

    const templates: { label: string; template: FormTemplate; description: string }[] = [
        { label: L('Пустая', 'Empty'), template: 'empty', description: L('setup form, конструктор, .init()', 'setup form, constructor, .init()') },
        { label: L('С кнопками «Применить» / «Закрыть»', 'With Apply / Close buttons'), template: 'applyClose', description: L('callbacks в .init() + метод .apply()', 'callbacks in .init() + .apply() method') },
    ];
    const tpl = await vscode.window.showQuickPick(templates, { title: L('Новая форма PML (4/4): шаблон', 'New PML form (4/4): template') });
    if (!tpl) return;

    // папка
    let dir = folder;
    if (!dir) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        const sub = cfg.get<string>('newFormFolder', '').trim();
        const def = ws && sub ? vscode.Uri.joinPath(ws, ...sub.split(/[\\/]+/).filter(Boolean)) : undefined;
        let defExists = false;
        if (def) { try { defExists = (await vscode.workspace.fs.stat(def)).type === vscode.FileType.Directory; } catch { /* нет */ } }
        if (defExists) dir = def;
        else {
            const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: L('Создать форму здесь', 'Create form here'), defaultUri: ws });
            dir = pick?.[0];
        }
    }
    if (!dir) return;
    const uri = vscode.Uri.joinPath(dir, formFileName(name.trim()));
    try {
        await vscode.workspace.fs.stat(uri);
        vscode.window.showErrorMessage(L(`Файл уже существует: ${vscode.workspace.asRelativePath(uri)}`, `File already exists: ${vscode.workspace.asRelativePath(uri)}`));
        return;
    } catch { /* файла нет — создаём */ }

    const text = newFormText({
        name: name.trim(), kind: kind.formKind, resize: kind.resize, title: title.trim() || name.trim(),
        developer: cfg.get<string>('developer') || os.userInfo().username,
        date: new Date().toISOString().slice(0, 10), template: tpl.template,
    });
    await vscode.workspace.fs.writeFile(uri, encodeUtf8Bom(text));
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    const rel = vscode.workspace.asRelativePath(uri), n = name.trim();
    vscode.window.showInformationMessage(L(`Создана форма !!${n} — ${rel}. В E3D: pml rehash, затем show !!${n}`,
        `Form !!${n} created — ${rel}. In E3D: pml rehash, then show !!${n}`));
}

function settings() {
    const c = vscode.workspace.getConfiguration('pmlFormDesigner');
    const style = c.get<string>('positionStyle', 'auto');
    return {
        placement: c.get<'init' | 'gadget'>('callbackPlacement', 'init'),
        style: style === 'auto' ? undefined : { spaced: style === 'spaced' } as CodeStyle,
    };
}

/** Выполнить операцию дизайнера и применить правки к документу. */
async function runOperation(document: vscode.TextDocument, req: Request, select: (name: string) => void) {
    const cfg = settings();
    if (req.op === 'callback') req = { ...req, placement: cfg.placement };
    let res = execute(document.getText(), req, cfg.style);
    if (res.confirm) {
        const yes = req.op === 'delete' ? L('Удалить', 'Delete') : L('Да', 'Yes');
        const a = await vscode.window.showWarningMessage(res.confirm, { modal: true }, yes);
        if (a !== yes) return;
        res = execute(document.getText(), { ...req, force: true } as Request, cfg.style);
    }
    if (res.error) { vscode.window.showWarningMessage(res.error); return; }
    if (res.edits.length) {
        const ok = await vscode.workspace.applyEdit(toWorkspaceEdit(document, res.edits));
        if (!ok) { vscode.window.showErrorMessage(L('Не удалось применить правку', 'Failed to apply the edit')); return; }
    }
    if (res.select) select(res.select);
    if (res.notice) vscode.window.showInformationMessage(res.notice);
    if (res.revealMethod) {
        const re = new RegExp(`^\\s*define\\s+method\\s+\\.${res.revealMethod}\\s*\\(`, 'i');
        for (let i = 0; i < document.lineCount; i++) {
            if (re.test(document.lineAt(i).text)) { await revealLine(document, Math.min(i + 1, document.lineCount - 1), true); break; }
        }
    }
}

/** LineEdit/LinesEdit → WorkspaceEdit (диапазоны не пересекаются: правки строятся по одному разбору). */
function toWorkspaceEdit(document: vscode.TextDocument, edits: Edit[]): vscode.WorkspaceEdit {
    const we = new vscode.WorkspaceEdit();
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    // удаление строк + вставка ровно в конец удаляемого диапазона (перенос) — одна замена, иначе VS Code сочтёт правки пересекающимися
    const merged: Edit[] = [];
    for (const e of edits) {
        const prev = merged[merged.length - 1];
        if (prev && !('start' in prev) && !('start' in e) && prev.insert.length === 0 && e.deleteCount === 0 && e.line === prev.line + prev.deleteCount) {
            merged[merged.length - 1] = { line: prev.line, deleteCount: prev.deleteCount, insert: e.insert };
        } else merged.push(e);
    }
    edits = merged;
    for (const e of edits) {
        if ('start' in e) {
            if (e.start === e.end && !e.newText) continue;
            we.replace(document.uri, new vscode.Range(e.line, e.start, e.line, e.end), e.newText);
        } else {
            const ins = e.insert.map(l => l + eol).join('');
            if (e.line >= document.lineCount) {
                // вставка в конец файла
                const last = document.lineAt(document.lineCount - 1);
                we.insert(document.uri, last.range.end, (last.text ? eol : '') + ins.slice(0, -eol.length));
            } else {
                const end = e.line + e.deleteCount;
                const range = end >= document.lineCount
                    ? new vscode.Range(e.line, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
                    : new vscode.Range(e.line, 0, end, 0);
                we.replace(document.uri, range, ins);
            }
        }
    }
    return we;
}

/** Перекодировать файл в UTF-8 с BOM (логика CP1251toUTF8). Исходник предварительно сохраняется в .bak рядом. */
async function convertToUtf8Bom(document: vscode.TextDocument, after: () => Promise<void>) {
    if (document.isDirty) {
        vscode.window.showWarningMessage(L('Сначала сохраните файл, затем конвертируйте кодировку.', 'Save the file first, then convert the encoding.'));
        return;
    }
    const rel = vscode.workspace.asRelativePath(document.uri), conv = L('Конвертировать', 'Convert');
    const ok = await vscode.window.showWarningMessage(
        L(`Конвертировать ${rel} в UTF-8 с BOM?`, `Convert ${rel} to UTF-8 with BOM?`), { modal: true }, conv);
    if (ok !== conv) return;
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const { text, encoding } = decodeFile(bytes);
    if (encoding === 'utf8bom') return;
    await vscode.workspace.fs.writeFile(document.uri.with({ path: document.uri.path + '.bak' }), bytes);
    await vscode.workspace.fs.writeFile(document.uri, encodeUtf8Bom(text));
    // перечитать документ с новой кодировкой (BOM определяется автоматически)
    await vscode.commands.executeCommand('workbench.action.files.revert');
    vscode.window.showInformationMessage(L(`Готово. Оригинал: ${rel}.bak`, `Done. Original: ${rel}.bak`));
    await after();
}

/** Показать строку в текстовом редакторе рядом (focus — перевести фокус в код, напр. к новому методу). */
async function revealLine(document: vscode.TextDocument, line: number, focus = false) {
    const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
    const editor = visible && !focus ? visible
        : await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: !focus });
    const range = document.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function shellHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = makeNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'designer.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'designer.js'));
    return `<!DOCTYPE html>
<html lang="${getLang()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
 <div id="banners"></div>
 <div id="toolbar">
   <span id="title">PML Form Designer</span>
   <button id="newForm" class="tbtn" data-i18n="newForm" data-i18n-title="newFormTip">＋ Новая форма</button>
   <span class="spacer"></span>
   <span class="seg" data-i18n-title="modeTip">
     <button id="modeRel" class="segb" data-i18n="rel">Отн.</button><button id="modeAbs" class="segb" data-i18n="abs">Абс.</button>
   </span>
   <label><span data-i18n="zoom">Масштаб</span> <input id="zoom" type="range" min="50" max="200" value="100"></label>
   <label><input id="showGrid" type="checkbox" checked> <span data-i18n="grid">сетка</span></label>
 </div>
 <div id="main">
   <div id="left">
     <div id="toolbox">
       <div class="tb-title" data-i18n="tbBasic">Основные</div>
       <div class="tool" draggable="true" data-type="button" data-i18n-title="tipButton" title="button .x |Кнопка| at … wid 10">▭ button</div>
       <div class="tool" draggable="true" data-type="text" data-i18n-title="tipText" title="text .x |Текст| at … wid 10 is STRING">⌨ text</div>
       <div class="tool" draggable="true" data-type="paragraph" data-i18n-title="tipPara" title="para .x at … text |Надпись|">A para</div>
       <div class="tool" draggable="true" data-type="toggle" data-i18n-title="tipToggle" title="toggle .x |Флажок| at …">☑ toggle</div>
       <div class="tool" draggable="true" data-type="option" data-i18n-title="tipOption" title="option .x |Выбор| at … wid 10">▾ option</div>
       <div class="tool" draggable="true" data-type="combo" data-i18n-title="tipCombo" title="combo .x |Список| tagwid 8 at … wid 10">⌄ combo</div>
       <div class="tool" draggable="true" data-type="list" data-i18n-title="tipList" title="list .x |Список| at … wid 20 hei 5">☰ list</div>
       <div class="tool" draggable="true" data-type="textpane" data-i18n-title="tipTextpane" title="textpane .x |Текст| at … wid 30 hei 5">¶ textpane</div>
       <div class="tb-title" data-i18n="tbContainers">Контейнеры</div>
       <div class="tool" draggable="true" data-type="frame" data-i18n-title="tipFrame" title="frame .x |Рамка| at … wid 20 hei 4 / exit">▢ frame</div>
       <div class="tool" draggable="true" data-type="tabset" data-i18n-title="tipTabset" title="frame .x tabset + страница">⧉ tabset</div>
       <div class="tool" draggable="true" data-type="radiogroup" data-i18n="toolRadiogroup" data-i18n-title="tipRadiogroup" title="frame с двумя rtoggle (группа переключателей, Справочник 12.1)">◉ группа rtoggle</div>
       <div class="tool" draggable="true" data-type="container" data-i18n-title="tipContainer" title="container .x PmlNetControl '' — для NetGrid / .NET">⊞ .NET container</div>
       <div class="tb-title" data-i18n="tbMore">Ещё</div>
       <div class="tool" draggable="true" data-type="rtoggle" data-i18n-title="tipRtoggle" title="rtoggle .x |Вариант| — только внутри frame">◉ rtoggle</div>
       <div class="tool" draggable="true" data-type="numericinput" data-i18n-title="tipNumeric" title="numericinput .x |Число| tagwid 8 at … range 0 100 ndp 0 wid 6">± numeric</div>
       <div class="tool" draggable="true" data-type="slider" title="slider .x horizontal at … range 0 100 step 1 val 50 wid 20">⊸ slider</div>
       <div class="tool" draggable="true" data-type="line" title="line .x at … horiz wid 30 hei 0.5">― line</div>
       <div class="tool" draggable="true" data-type="selector" data-i18n-title="tipSelector" title="selector .x |Элементы| at … single wid 25 hei 8 database auto">⌸ selector</div>
       <div class="tb-hint" data-i18n="tbHint">Перетащите на форму или выберите и щёлкните место</div>
     </div>
     <div id="tree"></div>
   </div>
   <div id="canvasWrap" tabindex="0"><div id="canvas"></div></div>
   <div id="props"><div class="empty" data-i18n="selectHint">Выберите гаджет на холсте или в дереве</div></div>
 </div>
 <div id="status"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
}

function makeNonce() {
    let s = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}
