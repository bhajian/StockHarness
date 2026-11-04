// #93 Lazy entry point for the code editor: Monaco loads on first use, so the studio's initial bundle
// does not grow. A toolbar slot sits above the editor.
import React, { lazy, Suspense, type ReactNode } from 'react';
import type { MonacoProps } from './MonacoEditor';

const Monaco = lazy(() => import('./MonacoEditor'));

export function CodeEditor({ toolbar, ...props }: MonacoProps & { toolbar?: ReactNode }) {
  return (
    <div className="code-editor">
      {toolbar && <div className="code-editor-toolbar">{toolbar}</div>}
      <Suspense
        fallback={
          <pre className="code-editor-fallback" style={{ height: props.height ?? 420 }}>
            {props.value}
          </pre>
        }
      >
        <Monaco {...props} />
      </Suspense>
    </div>
  );
}
export { tracebackMarkers, type CodeMarker } from './traceback';
