// Portfolio Builder (#461): a low-correlation book of the promising and successful ideas, with an audit of every pick;
// "Simulate this book" opens New simulation with the picks (over the exploration window).
import React, { useState } from 'react';
import { Layers, Play } from 'lucide-react';
import { send } from '../../api';
import { Field, Modal } from '../ui';
import { StatusPill } from '../kit';
import { openSchedule } from './SimulationsPage';

export function PortfolioBuilder({ onClose }: { onClose: () => void }) {
  const [maxIdeas, setMaxIdeas] = useState(8);
  const [corrCap, setCorrCap] = useState(0.5);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const build = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await send('/simulations/portfolio-builder', { maxIdeas, corrCap }));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Build a portfolio" onClose={onClose} wide>
      <div className="schedule-form">
        <div className="schedule-body">
          <p className="muted-line">
            Takes the promising and successful ideas, best score first (holdout excess when there is one, else
            the exploration Sharpe), and adds an idea only if its daily-return correlation with every pick
            stays under the cap over at least a year in common. The simulation runs over the exploration
            window.
          </p>
          <div className="form-row cols-3">
            <Field label="Ideas at most">
              <input
                type="number"
                min={2}
                max={8}
                value={maxIdeas}
                onChange={(e) => setMaxIdeas(Number(e.target.value))}
              />
            </Field>
            <Field label="Correlation cap" hint="0 to 1">
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={corrCap}
                onChange={(e) => setCorrCap(Number(e.target.value))}
              />
            </Field>
          </div>
          {result && (
            <div className="table-wrap">
              <table aria-label="Portfolio audit">
                <thead>
                  <tr>
                    <th>Idea</th>
                    <th>Decision</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.audit.map((a: any) => (
                    <tr key={a.ref}>
                      <td className="mono">{a.ref}</td>
                      <td>
                        <StatusPill
                          status={a.decision === 'picked' ? 'succeeded' : 'disabled'}
                          label={a.decision}
                        />
                      </td>
                      <td>{a.reason}</td>
                    </tr>
                  ))}
                  {!result.audit.length && (
                    <tr>
                      <td colSpan={3} className="muted-line">
                        No promising or successful ideas with an exploration yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="schedule-footer">
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Close
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={build}>
              <Layers size={14} /> {result ? 'Rebuild' : 'Build'}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!result?.picked?.length}
              onClick={() => {
                onClose();
                openSchedule({ ideas: result.picked });
              }}
            >
              <Play size={14} /> Simulate this book
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
