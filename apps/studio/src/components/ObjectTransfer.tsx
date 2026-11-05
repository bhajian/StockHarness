import React, { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { exportObjectsYaml, importObjectsYaml, type ObjectImportPlan, type ObjectKind } from '../api';
import { Button, Field, Modal } from './ui';

const KIND_LABEL: Record<ObjectKind, string> = {
  Skill: 'skills',
  Agent: 'agents',
  Harness: 'harnesses',
  DatasetSync: 'dataset syncs',
  Transform: 'transforms',
  CatalogEntry: 'catalog docs',
  Pipeline: 'pipelines',
  StrategyPlugin: 'strategy plugins',
  Evaluation: 'evaluations',
  Gates: 'success gates',
  ResearchSettings: 'research settings',
  Theory: 'theories',
};

/**
 * Export / Import YAML for one or more object kinds (#152). Every object is a `stockharness/v1` YAML document;
 * references are by name, and secrets and data rows are never included.
 */
export function ObjectTransfer({
  kinds = [],
  names = [],
  onImported,
  compact = false,
}: {
  kinds?: ObjectKind[];
  /** Export only these objects (by name); import is unaffected. */
  names?: string[];
  onImported?: () => Promise<void> | void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const what = kinds.length ? kinds.map((k) => KIND_LABEL[k]).join(', ') : 'all objects';
  async function download() {
    setError('');
    try {
      const text = await exportObjectsYaml(kinds, names);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `stockharness-${names.length === 1 ? names[0] : kinds.length ? kinds.join('-').toLowerCase() : 'all'}-${new Date().toISOString().slice(0, 10)}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <>
      <Button variant="secondary" onClick={download} title={`Export ${what} as YAML`}>
        <Download size={16} /> {compact ? 'Export' : 'Export YAML'}
      </Button>
      <Button variant="secondary" onClick={() => setOpen(true)} title={`Import ${what} from YAML`}>
        <Upload size={16} /> {compact ? 'Import' : 'Import YAML'}
      </Button>
      {error && <span className="object-transfer-error">{error}</span>}
      {open && (
        <ImportDialog
          what={what}
          defaultLegacy={kinds.length === 1 ? kinds[0] : undefined}
          onClose={() => setOpen(false)}
          onDone={async () => {
            setOpen(false);
            await onImported?.();
          }}
        />
      )}
    </>
  );
}

function ImportDialog({
  what,
  defaultLegacy,
  onClose,
  onDone,
}: {
  what: string;
  defaultLegacy?: ObjectKind;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [yaml, setYaml] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [legacy, setLegacy] = useState<ObjectKind | ''>(defaultLegacy ?? '');
  const [plan, setPlan] = useState<ObjectImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = (fn: () => void) => {
    fn();
    setPlan(null); // Apply always applies what was last previewed.
    setError('');
  };
  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await importObjectsYaml(yaml, mode, dryRun, legacy || undefined);
      if (!dryRun && r.applied) return void (await onDone());
      setPlan(r.plan);
      if (r.error)
        setError(
          `Stopped: ${r.error}${r.partial?.length ? ` (applied before it: ${r.partial.length})` : ''}`,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const changes = plan?.items.filter((i) => i.action !== 'unchanged') ?? [];
  const removes = plan?.items.filter((i) => i.action === 'remove').length ?? 0;
  return (
    <Modal title={`Import ${what} from YAML`} onClose={onClose} wide>
      <div className="form-content">
        <Field
          label="YAML file"
          hint="A StockHarness export, a Datasets YAML export, or a deploy/config-io file."
        >
          <input
            type="file"
            accept=".yaml,.yml,.json,application/yaml,text/yaml"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                const text = await file.text();
                edit(() => setYaml(text));
              }
            }}
          />
        </Field>
        <Field label="Or paste YAML">
          <textarea
            className="dataset-import-text"
            rows={10}
            spellCheck={false}
            value={yaml}
            onChange={(e) => edit(() => setYaml(e.target.value))}
            placeholder={'apiVersion: stockharness/v1\nkind: Harness\nmetadata: { name: … }\nspec: …'}
          />
        </Field>
        <div className="two-columns">
          <Field label="Mode">
            <select value={mode} onChange={(e) => edit(() => setMode(e.target.value as 'merge' | 'replace'))}>
              <option value="merge">Merge: create new objects, update ones with the same name</option>
              <option value="replace">
                Replace: also remove objects of these kinds that are not in the file
              </option>
            </select>
          </Field>
          <Field label="Kind of a bare list" hint="Only for config-io files that are a plain list.">
            <select value={legacy} onChange={(e) => edit(() => setLegacy(e.target.value as ObjectKind | ''))}>
              <option value="">Auto (stockharness/v1 objects)</option>
              <option value="Skill">Skills</option>
              <option value="Agent">Agents</option>
              <option value="Harness">Harnesses</option>
              <option value="DatasetSync">Dataset syncs</option>
            </select>
          </Field>
        </div>
        <p className="field-help">
          Objects are matched by kind and name. References (connections, model providers, knowledge bases) are
          resolved by name and must already exist here; they hold secrets, so they are never in the file. Data
          rows are never changed.
        </p>
        {error && <div className="notice error">{error}</div>}
        {plan && (
          <div className="dataset-plan" aria-live="polite">
            {plan.errors.length > 0 && (
              <div className="dataset-plan-section error">
                <strong>Errors: fix these first, nothing is applied ({plan.errors.length})</strong>
                <ul>
                  {plan.errors.map((e, i) => (
                    <li key={i}>
                      {e.kind ? `${e.kind} ` : ''}
                      {e.name ? `"${e.name}": ` : ''}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(['create', 'update', 'remove'] as const).map((action) => {
              const items = plan.items.filter((i) => i.action === action);
              return (
                items.length > 0 && (
                  <div key={action} className={`dataset-plan-section ${action === 'remove' ? 'error' : ''}`}>
                    <strong>
                      {action[0].toUpperCase() + action.slice(1)} ({items.length})
                    </strong>
                    <ul>
                      {items.map((i) => (
                        <li key={`${i.kind}:${i.name}`}>
                          {i.kind} · {i.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              );
            })}
            <div className="dataset-plan-section muted">
              Unchanged: {plan.items.filter((i) => i.action === 'unchanged').length}
              {!changes.length && !plan.errors.length ? ' · nothing to change' : ''}
            </div>
          </div>
        )}
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" disabled={!yaml.trim() || busy} onClick={() => run(true)}>
          Preview
        </Button>
        <Button
          type="button"
          variant={removes ? 'danger' : 'primary'}
          disabled={!plan || plan.errors.length > 0 || busy}
          title={!plan ? 'Preview the import first' : undefined}
          onClick={() => run(false)}
        >
          <Upload size={15} /> Apply import
        </Button>
      </div>
    </Modal>
  );
}
