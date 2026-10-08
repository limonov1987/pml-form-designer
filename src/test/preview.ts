// HTML-превью холста без VS Code: node out/test/preview.js <form.pmlfrm> <out.html> [строка выделения]
// Собирает те же media/designer.css + designer.js, подменяя acquireVsCodeApi, и передаёт данные как расширение.

import * as fs from 'fs';
import * as path from 'path';
import { decodeFile } from '../core/encoding';
import { parseForm, walkGadgets } from '../core/form';
import { layoutForm } from '../core/layout';

const [file, out, sel] = process.argv.slice(2);
const media = path.join(__dirname, '..', '..', 'media');
const { text, encoding } = decodeFile(fs.readFileSync(file));
const doc = parseForm(text);

// те же данные, что шлёт extension.ts (упрощённо: дерево и свойства — минимум для отрисовки)
const props: Record<number, unknown> = {};
for (const { node, parent } of walkGadgets(doc.nodes)) {
    const g = node.gadget;
    props[node.line] = {
        line: node.line, endLine: node.endLine ?? node.line, type: g.type, name: g.name, parent: parent?.gadget.name ?? '',
        tag: g.tag, x: '', y: '', atCount: g.atCount, width: '', height: '', callbackInCode: [], flags: g.flags, extras: g.extras,
        source: doc.lines[node.line].text.trim(),
    };
}
const tree = (nodes: typeof doc.nodes): unknown[] => nodes.flatMap(n => n.kind === 'gadget'
    ? [{ label: `${n.gadget.type} .${n.gadget.name}`, detail: n.gadget.tag ?? '', line: n.line, kind: n.gadget.type, children: n.children && tree(n.children) }]
    : []);
const msg = {
    type: 'render', encoding, fileName: path.basename(file),
    model: { formName: doc.formName, formAttrs: doc.formAttrs, setupLine: doc.setupLine, nodes: tree(doc.nodes), methods: [], problems: doc.problems, warnings: doc.warnings },
    layout: layoutForm(doc), props,
};

const shell = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
:root{--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#333;
--vscode-editorWidget-background:#252526;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;--vscode-list-activeSelectionForeground:#fff;
--vscode-editorWarning-foreground:#cca700;--vscode-editorError-foreground:#f14c4c;--vscode-textLink-foreground:#3794ff;--vscode-textCodeBlock-background:#2d2d2d;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-editor-font-family:Consolas}
${fs.readFileSync(path.join(media, 'designer.css'), 'utf8')}</style></head><body>
<div id="banners"></div>
<div id="toolbar"><span id="title"></span><span class="spacer"></span><label>Масштаб <input id="zoom" type="range" min="50" max="200" value="100"></label><label><input id="showGrid" type="checkbox" checked> сетка</label></div>
<div id="main"><div id="tree"></div><div id="canvasWrap"><div id="canvas"></div></div><div id="props"></div></div><div id="status"></div>
<script>window.acquireVsCodeApi=()=>({postMessage(m){if(m.type==='ready'){window.postMessage(${JSON.stringify(msg)},'*');${sel ? `setTimeout(()=>window.postMessage({type:'cursor',line:${+sel - 1}},'*'),50);` : ''}}},getState(){return {}},setState(){}});</script>
<script>${fs.readFileSync(path.join(media, 'designer.js'), 'utf8')}</script></body></html>`;
fs.writeFileSync(out, shell, 'utf8');
console.log('ok', out);
