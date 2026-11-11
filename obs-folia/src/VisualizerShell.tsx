import React from 'react';

// Host shell for the ported Tilt renderer. Folia's real shell also owns the
// backdrop and player chrome; the standalone OBS page provides those outside.
const VisualizerShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="folio-shell">{children}</div>
);

export default VisualizerShell;
