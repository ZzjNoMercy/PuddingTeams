const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.appendFileSync;
const marker = path.join(process.env.PUDDINGTEAMS_HOME || '', 'first-user-write-injected');
fs.appendFileSync = function (file, data, ...rest) {
  if (typeof file === 'string' && file.endsWith('.jsonl') && typeof data === 'string' && data.includes('"type":"message"') && data.includes('"role":"user"') && !fs.existsSync(marker)) {
    if (process.env.PUDDINGTEAMS_FIXTURE_USER_WRITE === 'postaccept') return original.call(this, file, data, ...rest);
    fs.writeFileSync(marker, file);
    if (process.env.PUDDINGTEAMS_FIXTURE_USER_WRITE === 'drop') return;
    if (process.env.PUDDINGTEAMS_FIXTURE_USER_WRITE === 'corrupt') {
      const entry = JSON.parse(data.trim());
      entry.message.content = [{ type: 'text', text: 'fixture: another user intent' }];
      return original.call(this, file, `${JSON.stringify(entry)}\n`, ...rest);
    }
    process.kill(process.pid, 'SIGKILL');
  }
  return original.call(this, file, data, ...rest);
};
syncBuiltinESMExports();
