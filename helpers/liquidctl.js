const { exec } = require('child_process');

function execCmd(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function isInstalled() {
  const { err } = await execCmd('liquidctl --version', 3000);
  return !err;
}

function parseListOutput(text) {
  // Accept a variety of formats; return array of {index, name, match}
  const devices = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Examples we attempt to match:
    // - Device 0, NZXT Kraken X (address: 0x0001)
    // - Device 1: Corsair Commander PRO (experimental)
    // - NZXT Kraken X (experimental) [0]
    let m = line.match(/Device\s+(\d+)[,:]\s*(.+)$/i) || line.match(/(.+)\s*\[(\d+)\]$/);
    if (m) {
      let index, name;
      if (m.length === 3 && /Device/i.test(line)) {
        index = parseInt(m[1], 10);
        name = m[2].trim();
      } else {
        name = m[1].trim();
        index = parseInt(m[2], 10);
      }
      devices.push({ index, name, match: name });
    }
  }
  return devices;
}

async function listDevices() {
  const installed = await isInstalled();
  if (!installed) return { installed: false, devices: [], error: 'liquidctl not found in PATH' };
  const { stdout } = await execCmd('liquidctl list');
  const devices = parseListOutput(stdout);
  return { installed: true, devices };
}

function parseStatusChannels(text) {
  // Return channels derived from status output: { channel, rpm, duty, temp, name }
  const channels = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Try to capture various lines like:
    // - Fan speed                      1200  rpm
    // - fan1 speed                     1300  rpm
    // - Pump speed                     2100  rpm
    // - Liquid temperature               31  °C
    const lower = line.toLowerCase();
    if (/(fan|pump).*\bspeed\b/.test(lower)) {
      // Extract channel name up to 'speed'
      const channel = lower.split('speed')[0].trim().replace(/\s+/g, '_'); // e.g., 'fan', 'fan1', 'pump'
      const rpmMatch = line.match(/([0-9]+)\s*rpm/i);
      const dutyMatch = line.match(/([0-9]+)\s*%/);
      channels.push({
        channel: channel || 'fan',
        rpm: rpmMatch ? parseInt(rpmMatch[1], 10) : null,
        duty: dutyMatch ? parseInt(dutyMatch[1], 10) : null,
        name: line.replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return channels;
}

async function getDeviceStatus(deviceMatch) {
  const installed = await isInstalled();
  if (!installed) return { installed: false, channels: [], error: 'liquidctl not found' };
  const { stdout, err, stderr } = await execCmd(`liquidctl --match "${deviceMatch}" status`);
  if (err) return { installed: true, channels: [], error: stderr || err.message };
  return { installed: true, channels: parseStatusChannels(stdout) };
}

async function setChannelSpeed(deviceMatch, channel, percent) {
  const installed = await isInstalled();
  if (!installed) return { ok: false, error: 'liquidctl not found' };
  if (percent < 0 || percent > 100) return { ok: false, error: 'percent out of range' };
  // Attempt a generic set; note that channel naming differs per device.
  // We try 'set <channel> speed <percent>' and fallback to 'set fan speed <percent>'
  const attempts = [
    `liquidctl --match "${deviceMatch}" set ${channel} speed ${percent}`,
    channel !== 'fan' ? `liquidctl --match "${deviceMatch}" set fan speed ${percent}` : null,
  ].filter(Boolean);

  let lastError = null;
  for (const cmd of attempts) {
    const { err, stderr } = await execCmd(cmd);
    if (!err) return { ok: true, cmd };
    lastError = stderr || err.message;
  }
  return { ok: false, error: lastError || 'Unknown error' };
}

module.exports = {
  isInstalled,
  listDevices,
  getDeviceStatus,
  setChannelSpeed,
};

