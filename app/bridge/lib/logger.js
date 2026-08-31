'use strict';

const fs = require('fs');
const path = require('path');

function createLogger(logPath, filesystem = fs) {
  return (event, detail = {}) => {
    try {
      filesystem.mkdirSync(path.dirname(logPath), { recursive: true });
      filesystem.appendFileSync(logPath, `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        detail,
      })}\n`);
    } catch (_) {}
  };
}

module.exports = { createLogger };
