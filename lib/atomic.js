'use strict';
// Crash-safe file writes: write to a temp file in the same directory, then rename over
// the target. A kill mid-write leaves a stray temp file, never a truncated original
// (which store's loadCache would silently skip — a vanished tournament).
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
