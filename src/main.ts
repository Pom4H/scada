import { EditorState, Transaction, type Annotation } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, isolateHistory } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { setDiagnostics } from '@codemirror/lint';
import { catalog, type Kind, type Endpoint, type Value } from './core';
import { compile, patchFields, applyChanges, editable, removeObject, appendEquipment, appendConnection, appendTap, formatSource, SourceError, type Compiled, type Change } from './source';
import { SceneView, el } from './view';
import './visual-components';
import { RuntimeWorkspace } from './runtime/workspace';
import type { SceneView3D } from './view3d';
import type { RuntimeFrame } from './runtime/protocol';
import { examples, booster } from './examples';
import standaloneCode from '../generated/runtime';
import './style.css';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => { const e = document.getElementById(id); if (!e) throw new Error(`Missing UI element: ${id}`); return e as T; };
const svg = document.getElementById('scene') as unknown as SVGSVGElement;
const sceneView = new SceneView(svg);
let spatialView: SceneView3D | null = null, spatialMode = false, runtimeUI: RuntimeWorkspace | undefined;
let displayedRuntime: RuntimeFrame | null = null;
sceneView.onSelect = id => select(id);
async function setSpatial(enabled: boolean) {
  if (enabled && !spatialView) {
    try {
      $('scene3d').hidden = false;
      const { SceneView3D } = await import('./view3d');
      spatialView = new SceneView3D($('scene3d'));
      spatialView.onSelect = id => select(id);
      if (compiled) spatialView.render(compiled.scene);
      spatialView.setRuntime(displayedRuntime); spatialView.select(selected); spatialView.paused = sceneView.paused;
    } catch (error) { $('scene3d').hidden = true; toast(`3D недоступен: ${error instanceof Error ? error.message : error}`); return; }
  }
  spatialMode = enabled; svg.style.display = enabled ? 'none' : ''; $('scene3d').hidden = !enabled;
  $('view-2d').setAttribute('aria-pressed', String(!enabled)); $('view-3d').setAttribute('aria-pressed', String(enabled));
  $('connect-mode').toggleAttribute('disabled', enabled || !!currentError);
  if (enabled) { clearConnect(); spatialView!.fit(); }
}
function runtimeLabel() {
  if (currentError) return;
  if (!displayedRuntime) { $('preview-state').textContent = 'Предпросмотр'; $('live-dot').style.background = sceneView.paused ? '#91a7af' : '#32a881'; return; }
  const offline = Object.values(displayedRuntime.flows).some(signal => signal.quality === 'offline');
  $('preview-state').textContent = offline ? 'Сигналы недоступны' : runtimeUI?.mode === 'replay' ? 'Сервер · запись' : 'Сервер · эфир';
  $('live-dot').style.background = offline ? '#cb9945' : runtimeUI?.mode === 'replay' ? '#8270a5' : '#32a881';
}
function displayRuntime(frame: RuntimeFrame | null) { displayedRuntime = frame; sceneView.setRuntime(frame); spatialView?.setRuntime(frame); runtimeLabel(); }
const workspace = document.querySelector<HTMLElement>('.workspace')!;
const STORAGE_KEY = 'scada.source.v1';
let compiled: Compiled | null = null, currentError: SourceError | null = null, selected: string | null = null;
let connecting: Endpoint | 'choose' | null = null;
let inspectorFor: string | null = null, errorDiagnostic: string | null = null;
let toastTimer = 0, spaceHeld = false, fileName = 'scene.ts', gestureAt = 0;
const source = () => editor.state.doc.toString();
function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => $('toast').classList.remove('visible'), 3800); }
function safely(fn: () => void) { try { fn(); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } }
function decodeShared(): string | null {
  if (!location.hash.startsWith('#code=')) return null;
  try {
    const raw = location.hash.slice(6); if (raw.length > 170_000) throw new Error('Ссылка слишком велика.');
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.length > 120_000) throw new Error('Проект слишком велик.');
    return value;
  } catch { toast('Не удалось прочитать общую ссылку. Открыта локальная версия.'); return null; }
}
let stored: string | null = null;
try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Storage can be unavailable in a private WebView. */ }
const initial = decodeShared() ?? stored ?? booster;
const editor = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: initial, extensions: [
  lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
  history({ newGroupDelay: 800, joinToEvent: (transaction, adjacent) => adjacent || transaction.isUserEvent('input.type.drag') || transaction.isUserEvent('input.type.inspector') }),
  javascript({ typescript: true }), syntaxHighlighting(HighlightStyle.define([{ tag: tags.keyword, color: '#91639f' }, { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#317894' }, { tag: tags.string, color: '#428675' }, { tag: tags.number, color: '#b67a3e' }, { tag: tags.comment, color: '#8b9d9f', fontStyle: 'italic' }, { tag: tags.variableName, color: '#415f72' }, { tag: tags.propertyName, color: '#547c91' }])), bracketMatching(), indentOnInput(), closeBrackets(),
  autocompletion({ override: [context => {
    const word = context.matchBefore(/[\w-]*/); if (!word || (word.from === word.to && !context.explicit)) return null;
    const options = [...Object.keys(catalog), 'component', 'runtime', 'connect', 'tap'].map(label => ({ label, type: 'function', detail: '@scada/core' }));
    for (const name of ['x', 'y', 'rpm', 'opening', 'level', 'quality', 'alarm', 'temperature', 'vibration', 'at', 'offset', 'value']) options.push({ label: name, type: 'property', detail: 'DSL' });
    for (const n of compiled?.scene.nodes ?? []) if (n.variable) options.push({ label: n.variable, type: 'variable', detail: n.id });
    return { from: word.from, options };
  }] }),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab, { key: 'Mod-s', run: () => { saveTS(); return true; } }]),
  EditorView.updateListener.of(update => { if (update.docChanged) refresh(true); }),
  EditorView.contentAttributes.of({ 'aria-label': 'TypeScript source editor', spellcheck: 'false' }),
] }) });
function dispatch(changes: readonly Change[], event = 'input.visual', isolate: 'before' | 'after' | 'full' | null = 'full') {
  const annotations: Annotation<unknown>[] = [Transaction.userEvent.of(event)];
  if (gestureAt && !isolate) annotations.push(Transaction.time.of(gestureAt));
  if (isolate) annotations.push(isolateHistory.of(isolate));
  editor.dispatch({ changes: [...changes].sort((a, b) => a.from - b.from), annotations });
}
function replaceSource(text: string) { dispatch([{ from: 0, to: editor.state.doc.length, insert: text }], 'input.replace'); }
function updateFields(id: string, patch: Record<string, Value>, event = 'input.type.inspector', isolate: 'before' | 'after' | 'full' | null = null) {
  if (currentError) throw new Error('Исправьте код перед редактированием схемы.');
  dispatch(patchFields(source(), id, patch), event, isolate);
}
function refresh(persist: boolean) {
  const text = source();
  try {
    compiled = compile(text); currentError = null;
    const channel = JSON.stringify([compiled.scene.nodes.map(n => [n.id, n.kind]), compiled.scene.links.map(l => l.id)]);
    if (channel !== trendChannel) { historySamples.length = 0; trendSVG.replaceChildren(); trendChannel = channel; }
    sceneView.render(compiled.scene); spatialView?.render(compiled.scene);
    if (selected && !compiled.objects.has(selected) && !compiled.scene.links.some(l => l.id === selected)) { selected = null; inspectorFor = null; }
    sceneView.select(selected);
    $('error-banner').hidden = true; $('preview-state').textContent = 'Предпросмотр';
    $('canvas').classList.remove('read-only'); $('live-dot').style.background = sceneView.paused ? '#91a7af' : '#32a881';
    $('empty-state').hidden = compiled.scene.nodes.length !== 0;
    $('counts').textContent = `${compiled.scene.nodes.length} элементов · ${compiled.scene.links.length} связей`;
  } catch (error) {
    currentError = error instanceof SourceError ? error : new SourceError(String(error));
    $('error-banner').hidden = false; $('preview-state').textContent = 'Последняя корректная';
    $('canvas').classList.add('read-only'); $('live-dot').style.background = '#d5984c';
  }
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, text); $('source-status').textContent = 'Сохранено локально'; $('save-dot').style.background = '#47a68c'; }
    catch { $('source-status').textContent = 'Сохраните .ts на диск'; $('save-dot').style.background = '#c3914f'; }
  }
  // Diagnostics dispatch does not change the document and therefore cannot recurse.
  const key = currentError ? `${currentError.from}:${currentError.to}:${currentError.message}` : null;
  if (key !== errorDiagnostic) {
    errorDiagnostic = key;
    queueMicrotask(() => {
      if (errorDiagnostic !== key) return;
      editor.dispatch(setDiagnostics(editor.state, currentError ? [{ from: Math.min(currentError.from, editor.state.doc.length), to: Math.min(currentError.to, editor.state.doc.length), severity: 'error', message: currentError.message }] : []));
    });
  }
  runtimeUI?.sourceChanged(currentError ? null : compiled); runtimeLabel();
  updateDiagnostics(); renderInspector();
  $('connect-mode').toggleAttribute('disabled', spatialMode || !!currentError); $('add').toggleAttribute('disabled', !!currentError);
}
function updateDiagnostics() {
  const messages: string[] = [];
  if (currentError) {
    const line = editor.state.doc.lineAt(Math.min(currentError.from, editor.state.doc.length));
    messages.push(`Строка ${line.number}: ${currentError.message}`);
  } else messages.push(...sceneView.warnings, ...sceneView.notes);
  $('diagnostic-count').textContent = currentError ? 'Ошибка TS' : messages.length ? `${messages.length} замечаний` : 'Нет ошибок';
  $('diagnostic-dot').style.background = currentError ? '#c86350' : messages.length ? '#cb9945' : '#26a386';
  $('diagnostics').replaceChildren();
  for (const message of messages.length ? messages : ['Синтаксис и геометрия проверены. Расход — упрощённая демонстрационная модель.']) { const p = document.createElement('p'); p.textContent = message; $('diagnostics').append(p); }
}
function setTab(tab: string) { workspace.dataset.tab = tab; document.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab))); editor.requestMeasure(); }
function select(id: string | null, reveal = false) {
  selected = id; sceneView.select(id); spatialView?.select(id); inspectorFor = null; renderInspector(); runtimeUI?.selectionChanged();
  if (id) workspace.classList.remove('no-inspector');
  if (reveal && id && compiled?.objects.has(id)) {
    const span = compiled.objects.get(id)!.span;
    editor.dispatch({ selection: { anchor: span.from }, effects: EditorView.scrollIntoView(span.from, { y: 'center' }) });
  }
}
function renderInspector() {
  const root = $('inspector-body');
  const item = compiled?.scene.nodes.find(n => n.id === selected);
  const edge = compiled?.scene.links.find(l => l.id === selected);
  const signature = item ? `${item.id}:${item.kind}` : (selected ?? "__empty__");
  if (inspectorFor !== signature || !root.childNodes.length) {
    inspectorFor = signature; root.replaceChildren();
    if (!item && !edge) {
      const p = document.createElement('p'); p.className = 'inspector-empty';
      const title = document.createElement('strong'); title.textContent = 'Выберите элемент';
      p.append(title, 'Нажмите на оборудование или трубопровод. Параметры, положение и состояние редактируются прямо в TypeScript.'); root.append(p); return;
    }
    const title = document.createElement('h2'); title.className = 'inspector-id'; title.textContent = item?.id ?? 'Трубопровод'; root.append(title);
    const kind = document.createElement('div'); kind.className = 'inspector-kind'; kind.textContent = item ? catalog[item.kind].label : `${edge!.from.node} → ${edge!.to.node}`; root.append(kind);
    if (item) {
      const coordinates = document.createElement('div'); coordinates.className = 'coordinates';
      for (const [name, definition] of Object.entries(catalog[item.kind].fields)) {
        const row = document.createElement('div'); row.className = 'field';
        const label = document.createElement('label'); label.htmlFor = `field-${name}`; label.textContent = definition.label;
        const unit = document.createElement('span'); unit.className = 'field-unit'; unit.textContent = definition.unit ?? ''; label.append(unit); row.append(label);
        if (definition.choices) {
          const input = document.createElement('select'); input.id = `field-${name}`; input.dataset.field = name;
          for (const choice of definition.choices) { const option = document.createElement('option'); option.value = choice; option.textContent = choice; input.append(option); }
          input.addEventListener('change', () => safely(() => updateFields(item.id, { [name]: typeof definition.default === 'number' ? Number(input.value) : typeof definition.default === 'boolean' ? input.value === 'true' : input.value }, 'input.type.inspector', 'full'))); row.append(input);
        } else if (typeof definition.default !== 'number') {
          const input = document.createElement('input'); input.type = typeof definition.default === 'boolean' ? 'checkbox' : 'text'; input.id = `field-${name}`; input.dataset.field = name;
          input.addEventListener('change', () => safely(() => updateFields(item.id, { [name]: input.type === 'checkbox' ? input.checked : input.value }, 'input.type.inspector', 'full'))); row.append(input);
        } else {
          const number = document.createElement('input'); number.type = 'number'; number.id = `field-${name}`; number.dataset.field = name; number.min = String(definition.min); number.max = String(definition.max); number.step = String(definition.step ?? 1);
          number.addEventListener('change', () => { safely(() => { if (!number.value.trim() || !number.checkValidity()) throw new Error(`${definition.label}: ${definition.min}…${definition.max}`); updateFields(item.id, { [name]: Number(number.value) }, 'input.type.inspector', 'full'); }); syncInspector(); }); row.append(number);
          if (!['x', 'y'].includes(name)) {
            const range = document.createElement('input'); range.type = 'range'; range.min = number.min; range.max = number.max; range.step = number.step; range.dataset.field = name; range.setAttribute('aria-label', definition.label);
            range.addEventListener('pointerdown', () => (gestureAt = Date.now(), editor.dispatch({ annotations: isolateHistory.of('before') })));
            range.addEventListener('input', () => safely(() => updateFields(item.id, { [name]: Number(range.value) })));
            range.addEventListener('change', () => (gestureAt = 0, editor.dispatch({ annotations: isolateHistory.of('after') }))); row.append(range);
          }
        }
        const note = document.createElement('div'); note.className = 'field-computed'; note.dataset.locked = name; note.textContent = 'Вычисляется в коде'; note.hidden = true; row.append(note);
        if (['x', 'y'].includes(name)) coordinates.append(row); else root.append(row);
      }
      if (coordinates.childNodes.length) root.insertBefore(coordinates, root.children[2] ?? null);
      if (item.kind === 'flowmeter') { const readout = document.createElement('div'); readout.className = 'inspector-readout'; readout.id = 'inspector-flow'; root.insertBefore(readout, root.children[2] ?? null); }
    } else {
      const actions = document.createElement('div'); actions.className = 'edge-actions';
      for (const [kind, text] of [['pressure', '+ Манометр'], ['temperature', '+ Термометр']] as const) { const b = document.createElement('button'); b.textContent = text; b.addEventListener('click', () => safely(() => { replaceSource(appendTap(source(), edge!.id, kind)); sceneView.fit(); })); actions.append(b); }
      root.append(actions);
    }
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = 'Удалить'; remove.id = 'delete-object'; remove.addEventListener('click', () => safely(deleteSelected)); root.append(remove);
  }
  syncInspector();
}
function syncInspector() {
  const item = compiled?.scene.nodes.find(n => n.id === selected);
  if (!item || !compiled) return;
  $('inspector-body').querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(input => {
    const key = input.dataset.field!;
    input.disabled = !!currentError || !editable(compiled!, item.id, key);
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(item.props[key]);
    else if (document.activeElement !== input) input.value = String(item.props[key]);
  });
  $('inspector-body').querySelectorAll<HTMLElement>('[data-locked]').forEach(n => n.hidden = editable(compiled!, item.id, n.dataset.locked!));
}
function deleteSelected() { if (!selected || currentError) return; const changes = removeObject(source(), selected); dispatch(changes, 'delete.visual'); select(null); }
function clearConnect() { connecting = null; svg.classList.remove('connecting'); $('connect-mode').setAttribute('aria-pressed', 'false'); $('hint').textContent = 'Перетаскивайте элементы. Нажмите на объект, чтобы изменить свойства.'; }
function choosePort(owner: string, port: string) {
  const n = compiled?.scene.nodes.find(n => n.id === owner); if (!n || currentError) return;
  const spec = catalog[n.kind].ports[port];
  if (!connecting || connecting === 'choose') {
    if (spec.role !== 'out') { toast('Сначала выберите выходной порт.'); return; }
    connecting = { node: owner, port }; svg.classList.add('connecting'); $('hint').textContent = `${owner}.${port} → выберите входной порт`; return;
  }
  const from = connecting;
  safely(() => { replaceSource(appendConnection(source(), from, { node: owner, port })); clearConnect(); });
}
interface Drag { id?: string; initialX: number; initialY: number; screenX: number; screenY: number; scale: number; x: number; y: number; moved: boolean; pointer: number }
let drag: Drag | null = null;
svg.addEventListener('pointerdown', event => {
  if (currentError || (event.button !== 0 && event.button !== 1)) return;
  const target = event.target as Element;
  const port = target.closest<SVGElement>('[data-port]');
  if (port && !spaceHeld) { event.preventDefault(); choosePort(port.dataset.owner!, port.dataset.port!); return; }
  const node = target.closest<SVGElement>('[data-node]'); const edge = target.closest<SVGElement>('[data-edge]');
  const matrix = svg.getScreenCTM(); const scale = matrix ? 1 / matrix.a : 1;
  if (node && !spaceHeld && event.button === 0) {
    const id = node.dataset.node!, item = compiled!.scene.nodes.find(n => n.id === id)!;
    select(id, true);
    if (catalog[item.kind].instrument) { toast('Отвод перемещается вместе с трубой. Точку и отступ можно изменить в свойствах.'); return; }
    if (!editable(compiled!, id, 'x') || !editable(compiled!, id, 'y')) { toast('Координаты вычисляются выражением. Отредактируйте формулу в TypeScript.'); return; }
    drag = { id, initialX: Number(item.props.x), initialY: Number(item.props.y), screenX: event.clientX, screenY: event.clientY, scale, x: 0, y: 0, moved: false, pointer: event.pointerId };
    (gestureAt = Date.now(), editor.dispatch({ annotations: isolateHistory.of('before') }));
  } else if (edge && !spaceHeld && event.button === 0) { select(edge.dataset.edge!); return; }
  else {
    if (!spaceHeld && event.button === 0) select(null);
    drag = { initialX: sceneView.camera.x, initialY: sceneView.camera.y, screenX: event.clientX, screenY: event.clientY, scale, x: 0, y: 0, moved: false, pointer: event.pointerId };
  }
  svg.setPointerCapture(event.pointerId); event.preventDefault();
});
svg.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  const dx = (event.clientX - drag.screenX) * drag.scale, dy = (event.clientY - drag.screenY) * drag.scale;
  if (Math.abs(event.clientX - drag.screenX) + Math.abs(event.clientY - drag.screenY) < 4 && !drag.moved) return;
  drag.moved = true;
  if (drag.id) {
    const snap = event.altKey ? 1 : 10;
    const x = Math.max(-3000, Math.min(6000, Math.round((drag.initialX + dx) / snap) * snap));
    const y = Math.max(-3000, Math.min(6000, Math.round((drag.initialY + dy) / snap) * snap));
    if (x === drag.x && y === drag.y) return;
    drag.x = x; drag.y = y;
    safely(() => updateFields(drag!.id!, { x, y }, 'input.type.drag'));
  } else sceneView.setCamera({ ...sceneView.camera, x: drag.initialX - dx, y: drag.initialY - dy });
});
function endDrag() { if (!drag) return; if (drag.id) (gestureAt = 0, editor.dispatch({ annotations: isolateHistory.of('after') })); drag = null; }
svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag); svg.addEventListener('lostpointercapture', endDrag);
svg.addEventListener('wheel', event => { event.preventDefault(); const before = sceneView.point(event.clientX, event.clientY); sceneView.zoom(Math.exp(event.deltaY * .0015)); const after = sceneView.point(event.clientX, event.clientY); sceneView.setCamera({ ...sceneView.camera, x: sceneView.camera.x + before.x - after.x, y: sceneView.camera.y + before.y - after.y }); }, { passive: false });
svg.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && (event.target as Element).hasAttribute('data-port')) { const p = event.target as SVGElement; event.preventDefault(); choosePort(p.dataset.owner!, p.dataset.port!); } });

$('deselect').addEventListener('click', () => select(null));
$('connect-mode').addEventListener('click', () => { if (connecting) clearConnect(); else { connecting = 'choose'; svg.classList.add('connecting'); $('connect-mode').setAttribute('aria-pressed', 'true'); $('hint').textContent = 'Выберите выходной порт, затем входной. Escape — отмена.'; } });
$('zoom-in').addEventListener('click', () => (spatialMode ? spatialView! : sceneView).zoom(.8)); $('zoom-out').addEventListener('click', () => (spatialMode ? spatialView! : sceneView).zoom(1.25)); $('fit').addEventListener('click', () => (spatialMode ? spatialView! : sceneView).fit());
$('view-2d').onclick = () => { void setSpatial(false); }; $('view-3d').onclick = () => { void setSpatial(true); };
$('toggle-code').addEventListener('click', () => { workspace.classList.toggle('no-code'); editor.requestMeasure(); });
$('toggle-inspector').addEventListener('click', () => workspace.classList.toggle('no-inspector'));
function updatePause() { $('pause').textContent = sceneView.paused ? '▷' : 'Ⅱ'; $('pause').setAttribute('aria-pressed', String(sceneView.paused)); $('pause').title = sceneView.paused ? 'Продолжить анимацию' : 'Пауза анимации'; $('live-dot').style.background = sceneView.paused ? '#91a7af' : '#32a881'; }
$('pause').addEventListener('click', () => { sceneView.paused = !sceneView.paused; if (spatialView) spatialView.paused = sceneView.paused; if (sceneView.paused && !runtimeUI?.active) historySamples.push({ at: performance.now(), value: null }); updatePause(); runtimeLabel(); }); updatePause();
$('undo').addEventListener('click', () => { undo(editor); }); $('redo').addEventListener('click', () => { redo(editor); });
$('format').addEventListener('click', () => safely(() => replaceSource(formatSource(source()))));
$('diagnostics-button').addEventListener('click', () => $('diagnostics').hidden = !$('diagnostics').hidden);
$('help').onclick = () => { const dialog = $('guide') as HTMLDialogElement; dialog.showModal(); };
$('guide-close').addEventListener('click', () => ($('guide') as HTMLDialogElement).close());
document.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab!)));
$('add').addEventListener('click', () => $('palette').hidden = !$('palette').hidden);
for (const [kind, spec] of Object.entries(catalog)) {
  const button = document.createElement('button'); button.textContent = spec.label;
  const code = document.createElement('span'); code.textContent = kind; button.append(code);
  button.addEventListener('click', () => safely(() => {
    if (spec.instrument) {
      if (!compiled?.scene.links.some(l => l.id === selected)) throw new Error('Сначала выберите трубу для подключения прибора.');
      replaceSource(appendTap(source(), selected!, kind as 'pressure' | 'temperature'));
    } else {
      const physical = compiled?.scene.nodes.filter(n => !catalog[n.kind].instrument) ?? [];
      const x = physical.length ? Math.ceil(Math.max(...physical.map(n => Number(n.props.x) + catalog[n.kind].width)) / 10) * 10 + 90 : 200;
      replaceSource(appendEquipment(source(), kind as Kind, Math.min(5900, x), 240));
      select(compiled!.scene.nodes.at(-1)!.id, true);
    }
    $('palette').hidden = true; sceneView.fit();
  }));
  $('palette').append(button);
}
document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('.add-wrap')) $('palette').hidden = true; });
const examplesSelect = $('examples') as HTMLSelectElement;
for (const [key, value] of Object.entries(examples)) { const option = document.createElement('option'); option.value = key; option.textContent = value.name; examplesSelect.append(option); }
examplesSelect.addEventListener('change', () => {
  if (source() !== initial && !window.confirm('Заменить текущий код примером? Отменить замену можно через Ctrl / ⌘ Z.')) return;
  clearConnect(); select(null); replaceSource(examples[examplesSelect.value].source); sceneView.fit();
});
let split: { start: number; width: number } | null = null;
$('splitter').addEventListener('pointerdown', e => { split = { start: e.clientX, width: document.querySelector('.code-panel')!.getBoundingClientRect().width }; $('splitter').setPointerCapture(e.pointerId); document.body.classList.add('resizing'); });
$('splitter').addEventListener('pointermove', e => { if (split) document.documentElement.style.setProperty('--code-width', `${Math.max(220, Math.min(innerWidth * .6, split.width + e.clientX - split.start))}px`); });
function stopSplit() { split = null; document.body.classList.remove('resizing'); editor.requestMeasure(); }
$('splitter').addEventListener('pointerup', stopSplit); $('splitter').addEventListener('pointercancel', stopSplit);
$('splitter').addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const width = document.querySelector('.code-panel')!.getBoundingClientRect().width; document.documentElement.style.setProperty('--code-width', `${Math.max(220, Math.min(innerWidth * .6, width + (e.key === 'ArrowLeft' ? -20 : 20)))}px`); e.preventDefault(); } });
function download(name: string, data: string, mime: string) { const url = URL.createObjectURL(new Blob([data], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000); }
function saveTS() { download(fileName, source(), 'text/typescript;charset=utf-8'); toast('Сохранён TypeScript — весь проект в одном файле.'); }
$('save').addEventListener('click', saveTS);
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const input = $('file') as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  try { if (file.size > 250_000) throw new Error('Файл слишком велик.'); const text = await file.text(); compile(text); if (source() !== initial && !confirm('Заменить текущий проект?')) return; fileName = file.name.endsWith('.ts') ? file.name : 'scene.ts'; clearConnect(); select(null); replaceSource(text); sceneView.fit(); toast(`Открыт ${fileName}`); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } finally { input.value = ''; }
});
$('share').addEventListener('click', async () => {
  try { const bytes = new TextEncoder().encode(runtimeUI?.shareSource() ?? source()); let binary = ''; bytes.forEach(byte => binary += String.fromCharCode(byte)); const code = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_'); const url = new URL(location.href); url.hash = `code=${code}`; if (url.href.length > 80_000) throw new Error('Для такого проекта используйте экспорт .ts.'); await navigator.clipboard.writeText(url.href); toast('Ссылка с исходным кодом скопирована.'); } catch (error) { toast('Не удалось скопировать ссылку: ' + (error instanceof Error ? error.message : error)); }
});
$('export').addEventListener('click', () => safely(() => {
  const model = compile(source()).scene;
  const safe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SCADA — схема</title><style>html,body{height:100%;margin:0;background:#f1f6f8;font-family:system-ui;color:#416172}body{display:flex;flex-direction:column}header{padding:12px 18px;border-bottom:1px solid #d6e4e9;display:flex;justify-content:space-between;font-size:12px}button{border:1px solid #a8c6d3;background:white;padding:6px 12px;border-radius:4px;color:#385e70;cursor:pointer}svg{flex:1;min-height:0;width:100%}.ports,.selection,.node-hit{display:none}.edge-hit{pointer-events:none}footer{padding:8px 18px;font-size:11px;color:#7893a1}</style></head><body><header><b>SCADA</b><button id="pause">Пауза</button></header><svg id="scene" xmlns="http://www.w3.org/2000/svg"></svg><footer>Демонстрационная схема · исходник встроен в этот файл</footer><script id="source" type="application/json">${safe(source())}</script><script id="model" type="application/json">${safe(model)}</script><script>${standaloneCode.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  download('scada-scene.html', html, 'text/html;charset=utf-8'); toast('Экспортирована автономная анимированная схема.');
}));
window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement; const typing = !!target.closest('input, select, textarea, .cm-editor, dialog');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveTS(); return; }
  if (typing) return;
  if (event.key === 'Escape') { clearConnect(); select(null); }
  if (event.code === 'Space') { spaceHeld = true; event.preventDefault(); }
  if (event.key.toLowerCase() === 'f') (spatialMode ? spatialView! : sceneView).fit();
  if (spatialMode && (/^Arrow/.test(event.key) || event.key === 'Delete' || event.key === 'Backspace')) return;
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); safely(deleteSelected); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo(editor) : undo(editor); }
  if (selected && /^Arrow/.test(event.key)) {
    const item = compiled?.scene.nodes.find(n => n.id === selected); if (!item || catalog[item.kind].instrument) return;
    event.preventDefault(); const step = event.shiftKey ? 1 : 10; const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    safely(() => updateFields(item.id, { x: Number(item.props.x) + dx, y: Number(item.props.y) + dy }, 'input.move', 'full'));
  }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') spaceHeld = false; }); window.addEventListener('blur', () => { spaceHeld = false; endDrag(); });
const trendSVG = document.getElementById('trend') as unknown as SVGSVGElement;
const historySamples: { at: number; value: number | null }[] = [];
let trendAt = 0, readoutAt = 0, trendChannel = '';
sceneView.onFrame = () => {
  const now = performance.now();
  if (runtimeUI?.active) return;
  if (now - readoutAt > 100) {
    readoutAt = now; const first = sceneView.scene.nodes.find(n => n.kind === 'flowmeter') ?? sceneView.scene.nodes.find(n => n.kind === 'pump'); const q = first ? sceneView.flows.get(first.id) : null;
    $('flow-readout').textContent = q == null ? '—' : `${q > 0 ? '+' : ''}${q.toFixed(1)}`;
    const readout = document.getElementById('inspector-flow'); if (readout && selected) { const v = sceneView.flows.get(selected); readout.textContent = v == null ? '— м³/ч' : `${v.toFixed(1)} м³/ч`; }
    if (now - trendAt > 500 && !sceneView.paused) {
      trendAt = now; historySamples.push({ at: now, value: q ?? null }); while (historySamples[0]?.at < now - 60_000) historySamples.shift();
      trendSVG.replaceChildren();
      for (const y of [8, 28, 48]) el(trendSVG, 'line', { x1: 0, y1: y, x2: 400, y2: y, stroke: '#e1e9ed', 'stroke-width': 1 });
      let d = '', gap = true;
      for (const sample of historySamples) { if (sample.value == null) { gap = true; continue; } const x = 400 - (now - sample.at) / 60_000 * 400, y = 28 - Math.max(-24, Math.min(24, sample.value)) / 24 * 23; d += `${gap ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`; gap = false; }
      el(trendSVG, 'path', { d, fill: 'none', stroke: '#2596ac', 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' });
    }
  }
};
window.addEventListener('hashchange', () => {
  const shared = decodeShared();
  if (shared !== null && shared !== source()) { clearConnect(); select(null); replaceSource(shared); sceneView.fit(); }
});
runtimeUI = new RuntimeWorkspace({ source, compiled: () => compiled, selected: () => selected, replaceSource, display: displayRuntime, toast });
refresh(false); sceneView.fit();
// A small inspection API makes deterministic browser regression tests possible.
// Mutations still go through the one CodeMirror document, never the rendered model.
Object.defineProperty(window, '__scada', { value: {
  get source() { return source(); }, get scene() { return compiled ? structuredClone(compiled.scene) : undefined; }, get error() { return currentError?.message ?? null; }, get warnings() { return sceneView.warnings; },
  get view3d() { return spatialView?.inspect() ?? null; },
  runtime: { get status() { return runtimeUI!.status; }, get frame() { return runtimeUI!.displayedFrame ? structuredClone(runtimeUI!.displayedFrame) : null; }, get liveFrame() { return runtimeUI!.frame ? structuredClone(runtimeUI!.frame) : null; }, get runId() { return runtimeUI!.runId; }, get mode() { return runtimeUI!.mode; },
    connect: (config: import('./runtime/protocol').RuntimeConfig, token: string) => runtimeUI!.connect(config, token), disconnect: () => runtimeUI!.disconnect(),
    createRun: (scenario: 'normal' | 'degradation') => runtimeUI!.createRun(scenario), selectRun: (id: string) => runtimeUI!.selectRun(id),
    command: (id: string, name: string, value?: number | string | boolean) => runtimeUI!.command(id, name, value),
    loadHistory: () => runtimeUI!.loadHistory(), replay: (seq: number) => runtimeUI!.replay(seq), live: () => runtimeUI!.live(),
    shareSource: () => runtimeUI!.shareSource(),
  },
  get flows() { return Object.fromEntries(sceneView.flows); }, get camera() { return { ...sceneView.camera }; },
  setSource: (text: string) => replaceSource(text), fit: () => sceneView.fit(), select: (id: string) => select(id), undo: () => undo(editor), redo: () => redo(editor),
}, writable: false });
window.addEventListener('pagehide', e => { if (!e.persisted) { sceneView.dispose(); spatialView?.dispose(); runtimeUI?.dispose(); } });
