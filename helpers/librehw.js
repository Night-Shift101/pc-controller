const fetch = require('node-fetch');

const DEFAULT_URL = process.env.LHM_URL || 'http://127.0.0.1:8085/data.json';

async function fetchJson(url = DEFAULT_URL, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function walkSensors(node, parentPath = '', out = { fans: [], temperatures: [] }) {
  if (!node || typeof node !== 'object') return out;
  const currentPath = parentPath ? `${parentPath} → ${node.Text || node.Name || ''}`.trim() : (node.Text || node.Name || '');

  const children = node.Children || node.children || [];
  for (const child of children) {
    // Sensor like nodes often have Type and SensorId
    if (child && child.Type && child.SensorId) {
      const type = (child.Type || '').toString().toLowerCase();
      const text = child.Text || child.Name || child.SensorId;

      if (type.includes('fan')) {
        const rpmValue = child.Value ? parseFloat(String(child.Value).replace(/[^0-9.]/g, '')) : 0;
        const minRpm = child.Min ? parseFloat(String(child.Min).replace(/[^0-9.]/g, '')) : 0;
        const maxRpm = child.Max ? parseFloat(String(child.Max).replace(/[^0-9.]/g, '')) : null;
        out.fans.push({
          id: child.SensorId,
          name: text,
          rpm: isFinite(rpmValue) ? rpmValue : 0,
          min: isFinite(minRpm) ? minRpm : 0,
          max: isFinite(maxRpm) ? maxRpm : null,
          hardware: currentPath,
          type: 'fan',
          status: rpmValue > 0 ? 'running' : 'stopped',
          health: rpmValue > 100 ? 'good' : (rpmValue > 0 ? 'warning' : 'stopped'),
          controllable: false,
          source: 'librehw'
        });
      } else if (type.includes('temperature')) {
        const tempValue = child.Value ? parseFloat(String(child.Value).replace(/[^0-9.]/g, '')) : null;
        out.temperatures.push({
          id: child.SensorId,
          name: text,
          value: isFinite(tempValue) ? tempValue : null,
          hardware: currentPath,
          type: 'temperature',
          source: 'librehw'
        });
      }
    }
    // Recurse
    walkSensors(child, currentPath, out);
  }
  return out;
}

async function getSensors() {
  try {
    const data = await fetchJson();
    const { fans, temperatures } = walkSensors(data);
    return { fans, temperatures, libre_hardware_available: true };
  } catch (e) {
    return { fans: [], temperatures: [], libre_hardware_available: false, error: e.message };
  }
}

module.exports = {
  getSensors,
};

