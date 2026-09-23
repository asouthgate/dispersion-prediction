import { useEffect, useRef, useState } from 'react';
import { useResults } from '@gsbio/engine';
import { FeaturePanel } from './FeaturePanel';
import { ParameterPanel } from './ParameterPanel';
import { RoostPanel } from './RoostPanel';
import { GeneratePanel } from './GeneratePanel';
import { LightUpload } from './LightUpload';
import { HelpPanel } from './HelpPanel';
import { RoostFinderImport, RoostFinderParams, RoostFinderRun } from './RoostFinderPanel';
import { Sun, Settings, EditPencilLine01, Layers, CircleHelp, FileUpload as FileUploadIcon, Play, Map, MapPin } from 'react-coolicons';

interface SectionDef {
  id: string;
  icon: React.ReactNode;
  label: string;
  defaultOpen?: boolean;
}

type PanelTab = 'connectivity' | 'roost';

export type { PanelTab };

const iconStyle = { width: 16, height: 16 };

const CONNECTIVITY_SECTIONS: SectionDef[] = [
  { id: 'lights', icon: <Sun style={iconStyle} />, label: 'Lighting' },
  { id: 'params', icon: <Settings style={iconStyle} />, label: 'Parameters' },
  { id: 'roost', icon: '◉', label: 'Roost' },
  { id: 'drawings', icon: <EditPencilLine01 style={iconStyle} />, label: 'Features' },
  { id: 'generate', icon: <Layers style={iconStyle} />, label: 'Generate' },
  { id: 'help', icon: <CircleHelp style={iconStyle} />, label: 'Help' },
];

const ROOST_SECTIONS: SectionDef[] = [
  { id: 'import', icon: <FileUploadIcon style={iconStyle} />, label: 'Import CSV', defaultOpen: true },
  { id: 'params', icon: <Settings style={iconStyle} />, label: 'Parameters' },
  { id: 'run', icon: <Play style={iconStyle} />, label: 'Run Model' },
];

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'connectivity', label: 'Connectivity' },
  { id: 'roost', label: 'Roost Finder' },
];

interface SidePanelProps {
  activeTab: PanelTab;
  onTabChange: (t: PanelTab) => void;
  collapsed: boolean;
  onToggleCollapsed: (c: boolean) => void;
}

export function SidePanel({ activeTab, onTabChange, collapsed, onToggleCollapsed }: SidePanelProps) {
  const [connectivityOpen, setConnectivityOpen] = useState<Set<string>>(new Set());
  const [roostOpen, setRoostOpen] = useState<Set<string>>(
    () => new Set(ROOST_SECTIONS.filter((s) => s.defaultOpen).map((s) => s.id)),
  );
  const { summaries } = useResults();

  const sections = activeTab === 'connectivity' ? CONNECTIVITY_SECTIONS : ROOST_SECTIONS;
  const openSections = activeTab === 'connectivity' ? connectivityOpen : roostOpen;
  const setOpenSections = activeTab === 'connectivity' ? setConnectivityOpen : setRoostOpen;

  const seenFinished = useRef(0);
  useEffect(() => {
    const finished = summaries.filter(
      (s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled',
    ).length;
    if (finished > seenFinished.current) {
      seenFinished.current = finished;
      setConnectivityOpen((prev) => prev.has('generate') ? prev : new Set(prev).add('generate'));
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
      case 'lights': return <LightUpload />;
      case 'params': return activeTab === 'roost' ? <RoostFinderParams /> : <ParameterPanel />;
      case 'roost': return <RoostPanel />;
      case 'drawings': return <FeaturePanel />;
      case 'generate': return <GeneratePanel />;
      case 'help': return <HelpPanel />;
      case 'import': return <RoostFinderImport />;
      case 'run': return <RoostFinderRun />;
      default: return null;
    }
  };

  const switchTab = (tab: PanelTab) => {
    onTabChange(tab);
    onToggleCollapsed(false);
  };

  if (collapsed) {
    return (
      <div className="side-panel side-panel--collapsed">
        <button className="panel-expand-btn" onClick={() => onToggleCollapsed(false)} title="Expand panel">◀</button>
        <nav className="panel-icon-rail">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`panel-icon-btn panel-icon-btn--tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => switchTab(t.id)}
              title={t.label}
            >
              <span className="panel-icon-content">{t.id === 'connectivity' ? <Map style={iconStyle} /> : <MapPin style={iconStyle} />}</span>
            </button>
          ))}
          <div className="panel-icon-rail-divider" />
          {sections.map((s) => (
            <button
              key={s.id}
              className={`panel-icon-btn ${openSections.has(s.id) ? 'active' : ''}`}
              onClick={() => { onToggleCollapsed(false); setOpenSections((prev) => new Set(prev).add(s.id)); }}
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
        <div className="side-panel-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`side-panel-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="panel-collapse-btn" onClick={() => onToggleCollapsed(true)} title="Collapse panel">▶</button>
      </div>
      <div className="side-panel-scroll">
        {sections.map((s) => {
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
        <div className="side-panel__logos">
          <div className="side-panel__logos-track">
            <img src="/logos/logo_cu.svg" alt="Cardiff University" className="side-panel__logo" />
            <img src="/logos/logo_hefcw_inv.png" alt="HEFCW" className="side-panel__logo" />
            <img src="/logos/logo_su.png" alt="University of Sussex" className="side-panel__logo" />
          </div>
        </div>
      </div>
    </div>
  );
}
