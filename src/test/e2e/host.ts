// Тестовый «хост» для webview в браузере: подменяет acquireVsCodeApi и делает то же, что extension.ts,
// но над строкой текста в памяти. Собирается esbuild в IIFE и подключается перед media/designer.js.

import { parseForm, printLines } from '../../core/form';
import { layoutForm } from '../../core/layout';
import { applyEdits } from '../../core/edits';
import { execute, Request } from '../../core/operations';
import { toViewModel, gadgetProps } from '../../core/viewModel';

declare global {
    interface Window {
        __text: string;
        __log: unknown[];
        __errors: string[];
        acquireVsCodeApi: () => unknown;
    }
}

const post = (m: unknown) => window.postMessage(m, '*');

function render() {
    const doc = parseForm(window.__text);
    post({ type: 'render', encoding: 'utf8bom', fileName: 'test.pmlfrm', model: toViewModel(doc), layout: layoutForm(doc), props: gadgetProps(doc) });
}

window.__log = [];
window.__errors = [];
let state: unknown = {};
window.acquireVsCodeApi = () => ({
    getState: () => state,
    setState: (s: unknown) => { state = s; },
    postMessage: (m: { type: string; req?: Request; line?: number }) => {
        window.__log.push(m);
        if (m.type === 'ready') render();
        if (m.type === 'op' && m.req) {
            let req = m.req;
            let res = execute(window.__text, req);
            if (res.confirm) { window.__log.push({ confirm: res.confirm }); res = execute(window.__text, { ...req, force: true } as Request); }   // «Да»/«Удалить»
            // как в extension.ts: перерисовка и при ошибке (снимает pending в webview)
            if (res.error) { window.__errors.push(res.error); render(); return; }
            window.__text = printLines(applyEdits(parseForm(window.__text).lines, res.edits));
            if (res.select) post({ type: 'selectName', name: res.select });
            render();
        }
    },
});
