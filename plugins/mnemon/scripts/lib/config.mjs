/**
 * Mnemon configuration defaults and strategy catalogue.
 *
 * Strategies decide how the available memory sources take part in a turn:
 * what stays resident in context and what is only searched on demand.
 */
export const STRATEGIES = ['layered', 'general', 'light-context', 'scoped'];

export const DEFAULT_CONFIG = {
  version: 1,
  strategy: 'layered',
  enhancements: {
    autoCapture: true,
    lightContext: false,
    scopedSources: false,
  },
  scope: 'global',
  workspaceDir: null,
  residentBudgetChars: 6000,
  searchBudget: 8,
  documentBudget: 3,
  candidateBudget: 20,
  keepRevisions: 20,
  redactSecrets: true,
  autoMergeThreshold: 0.82,
  duplicateThreshold: 0.82,
  conflictContainment: 0.55,
  staleAfterDays: 180,
  pinnedBoost: 0.5,
  snapshotRetention: 30,
  writePolicy: 'confirm-destructive',
};

export const STRATEGY_INFO = {
  layered: {
    label: 'Layered',
    resident: 'PERSONA.md + USER.md + MEMORY.md',
    onDemand: 'project documents, memory spaces',
    summary: 'Persona and runtime memory stay resident; everything else is searched first and read only when relevant.',
  },
  general: {
    label: 'General',
    resident: 'runtime memory (budgeted)',
    onDemand: 'every source inside one budget',
    summary: 'Every available source competes inside a single context budget and the model decides what to use.',
  },
  'light-context': {
    label: 'Light context',
    resident: 'runtime memory (half budget)',
    onDemand: 'memory spaces only',
    summary: 'A shared ceiling on resident context: keep turns small and pull evidence in explicitly.',
  },
  scoped: {
    label: 'Scoped',
    resident: 'ordered sources, writable subset',
    onDemand: 'ordered sources',
    summary: 'Compose an explicit order of sources and restrict which of them the agent may write to.',
  },
};

export const ENHANCEMENT_INFO = {
  autoCapture: {
    label: 'Active capture',
    summary: 'The Stop hook scans the finished turn for facts worth keeping and queues them for review.',
  },
  lightContext: {
    label: 'Light context ceiling',
    summary: 'Caps the injected resident block at half the configured budget.',
  },
  scopedSources: {
    label: 'Scoped sources',
    summary: 'Restricts on-demand search to the spaces listed in config.spaces.',
  },
};

export function mergeConfig(base, patch) {
  const out = { ...base, ...patch };
  out.enhancements = { ...base.enhancements, ...(patch.enhancements || {}) };
  return out;
}
