import { useEffect, useRef, useState } from 'react';
import { useResults } from '@gsbio/engine';
import type { PipelineStage } from '../models/horseshoeBat';
import { FeaturePanel } from './FeaturePanel';
import { ParameterPanel } from './ParameterPanel';
import { RoostPanel } from './RoostPanel';
import { GeneratePanel } from './GeneratePanel';
import { FileUpload } from './CsvUpload';
import { HelpPanel } from './HelpPanel';
import { Bulb } from 'react-coolicons';

interface SectionDef {
  id: string;
  icon: React.ReactNode;
  label: string;
  defaultOpen?: boolean;
}

const iconStyle = { width: 16, height: 16 };

const SECTIONS: SectionDef[] = [
  { id: 'lights', icon: <Bulb style={iconStyle} />, label: 'Street Lights' },
  { id: 'params', icon: '⚙', label: 'Parameters' },
  { id: 'roost', icon: '◯', label: 'Roost', defaultOpen: true },
  { id: 'drawings', icon: '◿', label: 'Drawings', defaultOpen: true },
  { id: 'generate', icon: '▦', label: 'Generate', defaultOpen: true },
  { id: 'help', icon: '⍰', label: 'Help' },
];

interface SidePanelProps {
  stage: PipelineStage;
  onStageChange: (s: PipelineStage) => void;
}

export function SidePanel({ stage, onStageChange }: SidePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const s of SECTIONS) if (s.defaultOpen) initial.add(s.id);
    return initial;
  });
  const { summaries } = useResults();

  const seenFinished = useRef(0);
  useEffect(() => {
    const finished = summaries.filter(
      (s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled',
    ).length;
    if (finished > seenFinished.current) {
      seenFinished.current = finished;
      setOpenSections((prev) => prev.has('generate') ? prev : new Set(prev).add('generate'));
    }
  }, [summaries]);

  const toggle = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderBody = (id: string) => {
    switch (id) {
      case 'lights': return <FileUpload />;
      case 'params': return <ParameterPanel />;
      case 'roost': return <RoostPanel />;
      case 'drawings': return <FeaturePanel />;
      case 'generate': return <GeneratePanel stage={stage} onStageChange={onStageChange} />;
      case 'help': return <HelpPanel />;
      default: return null;
    }
  };

  if (collapsed) {
    return (
      <div className="side-panel side-panel--collapsed">
        <button className="panel-expand-btn" onClick={() => setCollapsed(false)} title="Expand panel">◀</button>
        <nav className="panel-icon-rail">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`panel-icon-btn ${openSections.has(s.id) ? 'active' : ''}`}
              onClick={() => { setCollapsed(false); setOpenSections((prev) => new Set(prev).add(s.id)); }}
              title={s.label}
            >
              <span className="panel-icon-content">{s.icon}</span>
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="side-panel">
      <div className="side-panel-top-row">
{/*        <span className="side-panel-title">ECHO.MAPPER</span> */}
        <button className="panel-collapse-btn" onClick={() => setCollapsed(true)} title="Collapse panel">▶</button>
      </div>
      <div className="side-panel-scroll">
        {SECTIONS.map((s) => {
          const open = openSections.has(s.id);
          return (
            <div key={s.id} className="panel-section-block" data-open={String(open)}>
              <button
                className="panel-section-header"
                onClick={() => toggle(s.id)}
                aria-expanded={open}
              >
                <span className="panel-section-tick" />
                <span className="panel-section-chevron">{open ? '▾' : '▸'}</span>
                <span className="panel-section-icon"><span className="panel-icon-content">{s.icon}</span></span>
                <span className="panel-section-title">{s.label}</span>
              </button>
              {open && <div className="panel-section-body">{renderBody(s.id)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
