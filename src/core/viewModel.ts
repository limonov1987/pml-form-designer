// Данные для webview: дерево узлов и свойства гаджетов (общие для расширения и тестового стенда).

import { FormDocument, FormNode, walkGadgets } from './form';
import { Coord, SizeSpec } from './gadget';
import { CodeStyle, detectStyle, formatCoord } from './edits';

import { L } from './i18n';
interface ViewNode { label: string; detail: string; line: number; kind: string; children?: ViewNode[]; readOnly?: string }

export function toViewModel(doc: FormDocument) {
    const conv = (nodes: FormNode[]): ViewNode[] => nodes.flatMap((n): ViewNode[] => {
        const text = doc.lines[n.line].text.trim();
        switch (n.kind) {
            case 'gadget': {
                const g = n.gadget;
                const sub = g.type === 'frame' ? (g.flags.find(f => ['tabset', 'panel', 'folduppanel', 'toolbar'].includes(f)) ?? '') : '';
                return [{
                    label: `${g.type}${sub ? ' ' + sub : ''} .${g.name}`, detail: g.tag ?? g.text ?? '', line: n.line, kind: g.type,
                    readOnly: n.readOnly, children: n.children && conv(n.children),
                }];
            }
            case 'block': return [{ label: `${n.keyword} .${n.name}`, detail: '', line: n.line, kind: 'block', children: conv(n.children) }];
            case 'layout': return [{ label: `${n.command} ${n.value}`, detail: '', line: n.line, kind: 'layout' }];
            case 'member': return [{ label: `member .${n.name}`, detail: n.type, line: n.line, kind: 'member' }];
            case 'statement': return [{ label: text.length > 60 ? text.slice(0, 60) + '…' : text, detail: '', line: n.line, kind: 'statement' }];
            default: return [];
        }
    });
    return {
        formName: doc.formName, formAttrs: doc.formAttrs, setupLine: doc.setupLine,
        nodes: conv(doc.nodes), methods: doc.methods,
        problems: doc.problems, warnings: doc.warnings,
    };
}

const sizeText = (s?: SizeSpec) => !s ? '' : s.mode === 'abs' ? String(s.value) : s.mode === 'same' ? L(`как .${s.ref || '(предыдущий)'}`, `same as .${s.ref || '(previous)'}`) : s.raw;

/** Свойства гаджетов для панели свойств (ключ — номер строки). */
export function gadgetProps(doc: FormDocument, style?: CodeStyle) {
    const props: Record<number, unknown> = {};
    const st = style ?? detectStyle(doc);
    for (const { node, parent } of walkGadgets(doc.nodes)) {
        const g = node.gadget;
        const cb = doc.callbackAssigns.filter(c => c.gadget.toLowerCase() === g.name.toLowerCase());
        // режим оси: abs / rel / auto (не задана — автоматическая расстановка) / complex (сложное выражение)
        const mode = (c?: Coord) => !c ? 'auto' : !c.exact ? 'complex' : c.mode;
        const coordText = (c?: Coord) => !c ? '' : c.exact ? formatCoord(c, st) : doc.lines[node.line].text.slice(c.start, c.end);
        const sizeEdit = (s?: SizeSpec) => !s ? '' : s.mode === 'abs' ? String(s.value) : s.raw || sizeText(s);
        props[node.line] = {
            line: node.line, endLine: (node.endLine ?? node.line) + (node.continuation ?? 0),
            type: g.type, name: g.name, parent: parent?.gadget.name ?? '',
            tag: g.tag, text: g.text,
            x: coordText(g.at?.x), y: coordText(g.at?.y), xMode: mode(g.at?.x), yMode: mode(g.at?.y), atCount: g.atCount,
            width: sizeEdit(g.width), height: sizeEdit(g.height),
            widthMode: g.width?.mode ?? '', heightMode: g.height?.mode ?? '',
            callback: g.callback, callbackInCode: cb.map(c => ({ value: c.value, method: c.method, line: c.line })),
            tooltip: g.tooltip, anchor: g.anchor, dock: g.dock, pixmap: g.pixmap,
            flags: g.flags, extras: g.extras, readOnly: node.readOnly,
            isPage: parent?.gadget.flags.includes('tabset') ?? false,
            source: doc.lines[node.line].text.trim(),
        };
    }
    return props;
}
