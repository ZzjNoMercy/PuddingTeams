const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const mode = process.env.PUDDINGTEAMS_MESSAGE_CRASH_MODE;
const marker = path.join(process.env.PUDDINGTEAMS_HOME || '', `ordinary-message-${mode}-killed`);
const append = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
  const sessionEntry = typeof file === 'string' && file.endsWith('.jsonl') && typeof data === 'string';
  const target = sessionEntry && !fs.existsSync(marker) && (
    mode === 'after_user' && data.includes('"type":"message"') && data.includes('"role":"user"') ||
    mode === 'after_admission' && data.includes('"customType":"pudding:message_admission"')
  );
  const result = append.call(this, file, data, ...rest);
  if (target) {
    fs.writeFileSync(marker, file);
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
syncBuiltinESMExports();
