// #93 The Monaco editor, bundled locally (no CDN) and loaded lazily through CodeEditor.tsx.
// Python and YAML only; editing, read-only and side-by-side diff modes; markers from tracebacks.
import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/yaml/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { CodeMarker } from './traceback';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export type MonacoProps = {
  value: string;
  onChange?: (value: string) => void;
  language?: 'python' | 'yaml';
  readOnly?: boolean;
  /** When set, a side-by-side diff of `original` (left) against `value` (right). */
  original?: string;
  markers?: CodeMarker[];
  height?: number | string;
  /** Called with a function that inserts text at the cursor (for the inputs pane's snippets). */
  onReady?: (api: { insert: (text: string) => void; focus: () => void }) => void;
};

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 4,
  insertSpaces: true,
  renderWhitespace: 'selection',
};

export default function MonacoEditor({
  value,
  onChange,
  language = 'python',
  readOnly,
  original,
  markers,
  height = 420,
  onReady,
}: MonacoProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const isDiff = original !== undefined;

  useEffect(() => {
    if (!host.current) return;
    if (isDiff) {
      const d = monaco.editor.createDiffEditor(host.current, {
        ...OPTIONS,
        readOnly: true,
        renderSideBySide: true,
      });
      d.setModel({
        original: monaco.editor.createModel(original ?? '', language),
        modified: monaco.editor.createModel(value, language),
      });
      diff.current = d;
      return () => {
        const m = d.getModel();
        d.dispose();
        m?.original.dispose();
        m?.modified.dispose();
        diff.current = null;
      };
    }
    const e = monaco.editor.create(host.current, { ...OPTIONS, value, language, readOnly });
    editor.current = e;
    const sub = e.onDidChangeModelContent(() => changeRef.current?.(e.getValue()));
    onReady?.({
      insert: (text) => {
        const sel = e.getSelection();
        if (sel) e.executeEdits('snippet', [{ range: sel, text, forceMoveMarkers: true }]);
        e.focus();
      },
      focus: () => e.focus(),
    });
    return () => {
      sub.dispose();
      e.getModel()?.dispose();
      e.dispose();
      editor.current = null;
    };
    // Recreate only when the mode changes; value/original updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDiff, language]);

  useEffect(() => {
    const e = editor.current;
    if (e && e.getValue() !== value) e.setValue(value);
    const m = diff.current?.getModel();
    if (m) {
      if (m.original.getValue() !== (original ?? '')) m.original.setValue(original ?? '');
      if (m.modified.getValue() !== value) m.modified.setValue(value);
    }
  }, [value, original]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'oh',
      (markers ?? []).map((m) => ({
        startLineNumber: m.line,
        endLineNumber: m.line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(Math.min(m.line, model.getLineCount())),
        message: m.message,
        severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      })),
    );
    if (markers?.[0]) editor.current?.revealLineInCenterIfOutsideViewport(markers[0].line);
  }, [markers, value]);

  return <div ref={host} className="code-editor-host" style={{ height }} />;
}
