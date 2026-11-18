import React from 'react';

// Host shell for the ported renderers. Folia's real shell also owns the
// backdrop and player chrome; the standalone OBS page provides those outside.
// The ported modes pass their full shared props through; the shell ignores
// everything but children (kept in the signature so the copies compile).
const VisualizerShell: React.FC<{
  children: React.ReactNode;
  [key: string]: unknown;
}> = ({ children }) => (
  <div className="folio-shell">{children}</div>
);

export default VisualizerShell;