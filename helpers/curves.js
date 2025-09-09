const fs = require('fs');
const path = require('path');
const librehw = require('./librehw');
const liquidctl = require('./liquidctl');

const CURVES_PATH = path.join(process.cwd(), 'curves.json');

function readCurves() {
  try {
    if (!fs.existsSync(CURVES_PATH)) return { fans: {}, enabled: false };
    const raw = fs.readFileSync(CURVES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { fans: {}, enabled: false };
  }
}

function writeCurves(curves) {
  try {
    fs.writeFileSync(CURVES_PATH, JSON.stringify(curves, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function interpolate(points, x) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const sorted = points.slice().sort((a, b) => a.temp - b.temp);
  if (x <= sorted[0].temp) return sorted[0].percent;
  if (x >= sorted[sorted.length - 1].temp) return sorted[sorted.length - 1].percent;
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i], p2 = sorted[i + 1];
    if (x >= p1.temp && x <= p2.temp) {
      const t = (x - p1.temp) / (p2.temp - p1.temp);
      return Math.round(p1.percent + t * (p2.percent - p1.percent));
    }
  }
  return 0;
}

let loopHandle = null;

async function applyCurvesOnce(curves) {
  try {
    const { temperatures } = await librehw.getSensors();
    for (const [fanId, cfg] of Object.entries(curves.fans || {})) {
      if (!cfg || !cfg.enabled || !Array.isArray(cfg.curve) || cfg.curve.length === 0) continue;

      // Determine which temperature to read
      let tempValue = null;
      if (cfg.sensorId) {
        const t = temperatures.find(x => x.id === cfg.sensorId);
        tempValue = t ? t.value : null;
      }
      if (tempValue == null) {
        // Fallback: prefer CPU-ish temps
        const cpuTemp = temperatures.find(x => /cpu/i.test(x.name));
        tempValue = cpuTemp ? cpuTemp.value : null;
      }
      if (tempValue == null) continue;

      // Compute percent
      const percent = interpolate(cfg.curve, tempValue);

      // Only support liquidctl controlled fan ids
      if (fanId.startsWith('liquidctl:')) {
        const [, match, channel] = fanId.split(':');
        await liquidctl.setChannelSpeed(match, channel, percent);
      }
    }
  } catch (e) {
    // swallow
  }
}

function ensureLoop() {
  const curves = readCurves();
  if (curves.enabled && !loopHandle) {
    loopHandle = setInterval(() => applyCurvesOnce(curves), 2000);
  } else if (!curves.enabled && loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}

function setEnabled(enabled) {
  const curves = readCurves();
  curves.enabled = !!enabled;
  writeCurves(curves);
  ensureLoop();
  return curves.enabled;
}

function saveFanCurves(updates) {
  // updates: array of { fanId, curve, sensorId, enabled }
  const curves = readCurves();
  curves.fans = curves.fans || {};
  for (const item of updates) {
    if (!item || !item.fanId) continue;
    curves.fans[item.fanId] = {
      curve: Array.isArray(item.curve) ? item.curve : [],
      sensorId: item.sensorId || (curves.fans[item.fanId] && curves.fans[item.fanId].sensorId) || null,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : (curves.fans[item.fanId] && curves.fans[item.fanId].enabled) || false,
    };
  }
  writeCurves(curves);
  ensureLoop();
  return curves;
}

module.exports = {
  readCurves,
  writeCurves,
  ensureLoop,
  setEnabled,
  saveFanCurves,
};

