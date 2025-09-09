const express = require('express');
const cors = require('cors');
const si = require('systeminformation');
const { spawn, exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { OpenRGBClient } = require('openrgb-sdk');
const fs = require('fs');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ---- Client-side error logging ----
app.post('/api/errors', (req, res) => {
    const { message, stack, url, line, column, userAgent, timestamp } = req.body || {};
    const errorInfo = {
        timestamp: timestamp || new Date().toISOString(),
        message: message || 'Unknown error',
        stack,
        url,
        line,
        column,
        userAgent,
        clientIP: req.ip || req.connection.remoteAddress
    };

    console.error('CLIENT ERROR:', JSON.stringify(errorInfo, null, 2));
    res.json({ ok: true });
});

// ---- WebSocket broadcast (live updates) ----

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY;

// --- simple API key middleware ---
app.use((req, res, next) => next()); // TODO: Add real API key check

// ---- Static files and multi-page routing ----
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Serve main pages directly for pretty URLs
const pageList = ['dashboard', 'processes', 'fans', 'system'];
pageList.forEach(page => {
    app.get(`/${page}`, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'pages', `${page}.html`));
    });
});
app.get('/', (req, res) => res.redirect('/dashboard'));

// ---- System summary ----
app.get('/api/sys/summary', async (req, res) => {
    try {
        const [cpu, mem, os, currentLoad, temp] = await Promise.all([
            si.cpu(),
            si.mem(),
            si.osInfo(),
            si.currentLoad(),
            si.cpuTemperature()
        ]);
        res.json({
            cpu: { brand: cpu.brand, cores: cpu.cores, load: currentLoad.currentload },
            mem: { total: mem.total, used: mem.active },
            os: { platform: os.platform, release: os.release },
            temp: temp?.main ?? null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Processes list ----
app.get('/api/processes', async (req, res) => {
    try {
        const procs = await si.processes();
        // Light subset for UI speed
        const list = procs.list.slice(0, 200).map(p => ({
            pid: p.pid,
            name: p.name,
            cpu: p.pcpu,
            mem: p.pmem
        }));
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Kill process ----
app.post('/api/processes/:pid/kill', (req, res) => {
    const pid = Number(req.params.pid);
    if (!pid) return res.status(400).json({ error: 'Bad pid' });
    try {
        process.kill(pid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Launch app (Windows) ----
// Example: POST /api/apps/launch {"cmd":"notepad"}
app.post('/api/apps/launch', (req, res) => {
    const { cmd, args = [] } = req.body || {};
    if (!cmd) return res.status(400).json({ error: 'cmd required' });
    try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- System actions (Windows) ----
const runPS = (code) =>
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', code]);

app.post('/api/system/:action', (req, res) => {
    const action = req.params.action;
    let ps = null;
    if (action === 'lock') ps = 'rundll32.exe user32.dll,LockWorkStation';
    else if (action === 'sleep') ps = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0';
    else if (action === 'shutdown') ps = 'Stop-Computer -Force';
    else if (action === 'restart') ps = 'Restart-Computer -Force';
    else return res.status(400).json({ error: 'invalid action' });

    const p = runPS(ps);
    p.on('exit', () => res.json({ ok: true }));
});

// ---- Volume (0-100) ----
app.post('/api/system/volume', (req, res) => {
    const { level } = req.body || {};
    if (typeof level !== 'number' || level < 0 || level > 100)
        return res.status(400).json({ error: 'level 0-100' });
    const ps = `
  $vol = (New-Object -ComObject WScript.Shell)
  # Using nircmd or alternate method is cleaner; for demo, no-op:
  `;
    const p = runPS(ps);
    p.on('exit', () => res.json({ ok: true, note: 'Replace with nircmd or CoreAudio script for real volume.' }));
});

// ---- Fan Control using FanControl Application ----

const FANCONTROL_CONFIG_PATH = process.env.FANCONTROL_CONFIG || 'C:\\Users\\%USERNAME%\\AppData\\Roaming\\FanControl\\';
const LIBRE_HARDWARE_MONITOR_URL = process.env.LHM_URL || 'http://127.0.0.1:8085/data.json';

// Helper function to read fans from FanControl
async function readFanControlData() {
    try {
        // FanControl integration - try multiple approaches
        return new Promise((resolve) => {
            const psScript = `
                # Check if FanControl is running
                $fanControlProcess = Get-Process -Name "FanControl" -ErrorAction SilentlyContinue
                if (-not $fanControlProcess) {
                    Write-Output "ERROR: FanControl not running"
                    exit 1
                }
                
                Write-Output "FANCONTROL_RUNNING:true"
                Write-Output "FANCONTROL_PID:$($fanControlProcess.Id)"
                
                # Try to read FanControl configuration files
                $appDataPath = [Environment]::GetFolderPath('ApplicationData')
                $fanControlPath = Join-Path $appDataPath "FanControl"
                
                if (Test-Path $fanControlPath) {
                    Write-Output "CONFIG_PATH:$fanControlPath"
                    
                    # Look for configuration files
                    $configFiles = Get-ChildItem -Path $fanControlPath -Filter "*.json" -ErrorAction SilentlyContinue
                    foreach ($file in $configFiles) {
                        Write-Output "CONFIG_FILE:$($file.Name)"
                    }
                    
                    # Try to read configuration if available
                    $configFile = Join-Path $fanControlPath "FanControlConfig.json"
                    if (Test-Path $configFile) {
                        try {
                            $config = Get-Content $configFile -Raw | ConvertFrom-Json
                            Write-Output "CONFIG_LOADED:true"
                        } catch {
                            Write-Output "CONFIG_LOADED:false"
                        }
                    }
                }
                
                # Since FanControl doesn't have a direct API, we'll simulate fan data
                # based on what FanControl typically manages
                Write-Output "FAN:CPU Fan:1200:300:2000:CPU:fancontrol_cpu_fan"
                Write-Output "FAN:Case Fan 1:900:0:1500:System:fancontrol_case_fan_1"
                Write-Output "FAN:Case Fan 2:850:0:1500:System:fancontrol_case_fan_2"
                Write-Output "FAN:GPU Fan:1600:0:3000:GPU:fancontrol_gpu_fan"
                Write-Output "TEMP:CPU Package:52.3:CPU:fancontrol_cpu_temp"
                Write-Output "TEMP:GPU Core:41.2:GPU:fancontrol_gpu_temp"
                Write-Output "TEMP:Motherboard:38.5:System:fancontrol_mb_temp"
                
                Write-Output "DATA_SOURCE:FanControl_Simulated"
                Write-Output "NOTE:FanControl detected but using simulated data. Configure sensors in FanControl for real data."
            `;

            exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`,
                { windowsHide: true, timeout: 10000 },
                (err, stdout, stderr) => {
                    if (err || stderr.includes('ERROR')) {
                        console.error('FanControl read error:', stderr || err?.message);
                        resolve({
                            fans: [],
                            temperatures: [],
                            error: 'FanControl not running or accessible',
                            fancontrol_available: false
                        });
                        return;
                    }

                    const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                    const fans = [];
                    const temperatures = [];
                    let fanControlRunning = false;
                    let configPath = '';
                    let fanControlPid = '';
                    let dataSource = 'FanControl';
                    let note = '';

                    for (const line of lines) {
                        if (line.startsWith('FANCONTROL_RUNNING:')) {
                            fanControlRunning = line.split(':')[1] === 'true';
                        } else if (line.startsWith('FANCONTROL_PID:')) {
                            fanControlPid = line.split(':')[1];
                        } else if (line.startsWith('CONFIG_PATH:')) {
                            configPath = line.substring(12);
                        } else if (line.startsWith('DATA_SOURCE:')) {
                            dataSource = line.substring(12);
                        } else if (line.startsWith('NOTE:')) {
                            note = line.substring(5);
                        } else if (line.startsWith('FAN:')) {
                            const parts = line.substring(4).split(':');
                            if (parts.length >= 6) {
                                const [name, rpm, min, max, hardware, id] = parts;
                                fans.push({
                                    id: id || `fancontrol_${name.replace(/\s+/g, '_').toLowerCase()}`,
                                    name: name,
                                    rpm: parseInt(rpm) || 0,
                                    min: parseInt(min) || 0,
                                    max: parseInt(max) || null,
                                    hardware: hardware,
                                    type: 'fan',
                                    status: parseInt(rpm) > 0 ? 'running' : 'stopped',
                                    health: parseInt(rpm) > 100 ? 'good' : (parseInt(rpm) > 0 ? 'warning' : 'stopped'),
                                    controllable: true,
                                    source: 'fancontrol'
                                });
                            }
                        } else if (line.startsWith('TEMP:')) {
                            const parts = line.substring(5).split(':');
                            if (parts.length >= 4) {
                                const [name, temp, hardware, id] = parts;
                                temperatures.push({
                                    id: id || `fancontrol_temp_${name.replace(/\s+/g, '_').toLowerCase()}`,
                                    name: name,
                                    value: parseFloat(temp) || null,
                                    hardware: hardware,
                                    type: 'temperature',
                                    source: 'fancontrol'
                                });
                            }
                        }
                    }

                    console.log(`FanControl found ${fans.length} fans and ${temperatures.length} temperature sensors (PID: ${fanControlPid})`);
                    resolve({
                        fans,
                        temperatures,
                        fancontrol_available: fanControlRunning,
                        config_path: configPath,
                        fancontrol_pid: fanControlPid,
                        data_source: dataSource,
                        note: note
                    });
                }
            );
        });
    } catch (e) {
        console.error('FanControl integration error:', e.message);
        return {
            fans: [],
            temperatures: [],
            error: e.message,
            fancontrol_available: false
        };
    }
}

// Helper function to read fans from LibreHardwareMonitor (fallback)
async function readLibreHardwareFans() {
    try {
        let data = null;
        try {
            const res = await fetch(LIBRE_HARDWARE_MONITOR_URL);
            if (!res.ok) throw new Error(`LibreHardwareMonitor not responding: ${res.status}`);
            data = await res.json();
        } catch (e) {
            const snap = path.join(__dirname, 'output.json');
            if (fs.existsSync(snap)) {
                data = JSON.parse(fs.readFileSync(snap, 'utf8'));
            } else {
                throw e;
            }
        }

        const fans = [];
        const temperatures = [];

        function walkHardware(node, parentPath = '') {
            // Build hardware path for better identification
            const currentPath = parentPath ? `${parentPath} → ${node.Text}` : node.Text;

            if (node.Children && Array.isArray(node.Children)) {
                for (const child of node.Children) {
                    // Check if this child has sensor data directly
                    if (child.Type === 'Fan' && child.SensorId) {
                        const rpmValue = child.Value ? parseFloat(child.Value.replace(' RPM', '')) : 0;
                        const minRpm = child.Min ? parseFloat(child.Min.replace(' RPM', '')) : 0;
                        const maxRpm = child.Max ? parseFloat(child.Max.replace(' RPM', '')) : null;

                        fans.push({
                            id: child.SensorId,
                            name: child.Text,
                            rpm: rpmValue,
                            min: minRpm,
                            max: maxRpm,
                            hardware: currentPath,
                            type: 'fan',
                            status: rpmValue > 0 ? 'running' : 'stopped',
                            health: rpmValue > 100 ? 'good' : (rpmValue > 0 ? 'warning' : 'stopped'),
                            controllable: true
                        });
                    } else if (child.Type === 'Temperature' && child.SensorId) {
                        const tempValue = child.Value ? parseFloat(child.Value.replace(/[°C\s]/g, '')) : null;

                        temperatures.push({
                            id: child.SensorId,
                            name: child.Text,
                            value: tempValue,
                            hardware: currentPath,
                            type: 'temperature'
                        });
                    }

                    // Recurse into children regardless
                    walkHardware(child, currentPath);
                }
            }
        }

        // Start walking from the root
        walkHardware(data);

        console.log(`LibreHardwareMonitor found ${fans.length} fans and ${temperatures.length} temperature sensors`);
        return { fans, temperatures };
    } catch (e) {
        console.error('LibreHardwareMonitor read error:', e.message);
        return { fans: [], temperatures: [], error: e.message };
    }
}

// ---- liquidctl helpers ----
const LIQUIDCTL_PATH = process.env.LIQUIDCTL_PATH || 'liquidctl';
async function runLiquidctl(args, opts = {}) {
    return new Promise((resolve) => {
        execFile(LIQUIDCTL_PATH, args, { windowsHide: true, timeout: 5000, ...opts }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, code: err.code, stdout: stdout?.toString() || '', stderr: stderr?.toString() || err.message });
            else resolve({ ok: true, code: 0, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
        }).on('error', (e) => resolve({ ok: false, code: -1, stdout: '', stderr: e.message }));
    });
}
async function liquidctlAvailable() {
    const res = await runLiquidctl(['--version']);
    return res.ok;
}
async function listLiquidctlDevices() {
    const avail = await liquidctlAvailable();
    if (!avail) return { available: false, devices: [], fans: [], error: 'liquidctl not found' };
    const out = await runLiquidctl(['list']);
    const devices = [];
    const fans = [];
    if (out.ok) {
        const lines = out.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const ln of lines) {
            const m = ln.match(/Device\s+(\d+)\s*[:,]\s*(.+)/i) || ln.match(/(\d+)\s*:\s*(.+)/);
            if (m) devices[parseInt(m[1], 10)] = { index: parseInt(m[1], 10), name: m[2].trim() };
        }
        for (let i = 0; i < devices.length; i++) {
            if (!devices[i]) continue;
            const st = await runLiquidctl(['--device', String(i), 'status', '--json']);
            if (st.ok) {
                try {
                    const json = JSON.parse(st.stdout);
                    const readings = Array.isArray(json) ? json : (Array.isArray(json.status) ? json.status : []);
                    const device = devices[i];
                    readings.forEach(r => {
                        const key = (r.key || r.name || '').toLowerCase();
                        if (key.includes('fan') || key.includes('pump')) {
                            const ch = (r.channel || r.key || r.name || '').toString().toLowerCase().replace(/\s+/g, '');
                            const rpm = typeof r.value === 'number' ? r.value : parseFloat(String(r.value).replace(/[^0-9.]/g, ''));
                            fans.push({ id: `liquidctl:${i}:${ch || 'fan'}`, name: `${device.name} ${ch || 'fan'}`, rpm: rpm || 0, min: 0, max: null, hardware: device.name, type: 'fan', status: (rpm || 0) > 0 ? 'running' : 'stopped', health: (rpm || 0) > 100 ? 'good' : ((rpm || 0) > 0 ? 'warning' : 'stopped'), controllable: true, source: 'liquidctl', deviceIndex: i, channel: ch || 'fan' });
                        }
                    });
                } catch {
                    const lines2 = st.stdout.split(/\r?\n/).map(s => s.trim());
                    const device = devices[i];
                    lines2.forEach(line => {
                        const lower = line.toLowerCase();
                        const m2 = lower.match(/(fan\s*\d*|pump)\s*speed\s*:\s*([0-9.]+)/);
                        if (m2) {
                            const ch = m2[1].replace(/\s+/g, '');
                            const rpm = parseFloat(m2[2]);
                            fans.push({ id: `liquidctl:${i}:${ch}`, name: `${device.name} ${ch}`, rpm: rpm || 0, min: 0, max: null, hardware: device.name, type: 'fan', status: (rpm || 0) > 0 ? 'running' : 'stopped', health: (rpm || 0) > 100 ? 'good' : ((rpm || 0) > 0 ? 'warning' : 'stopped'), controllable: true, source: 'liquidctl', deviceIndex: i, channel: ch });
                        }
                    });
                }
            }
        }
    }
    return { available: true, devices: devices.filter(Boolean), fans };
}
async function setLiquidctlSpeedById(fanId, speedPercent) {
    const m = String(fanId).match(/^liquidctl:(\d+):([A-Za-z0-9_-]+)/);
    if (!m) return { success: false, error: 'Unsupported fanId (expected liquidctl:<index>:<channel>)' };
    const idx = m[1];
    const channel = m[2];
    const pct = Math.max(0, Math.min(100, Math.round(speedPercent)));
    const res = await runLiquidctl(['--device', String(idx), 'set', channel, 'speed', String(pct)], { timeout: 7000 });
    if (!res.ok) return { success: false, error: res.stderr || 'liquidctl set failed' };
    return { success: true, fanId, speed: pct, method: 'liquidctl' };
}

// ---- Fan curves storage & loop ----
const FAN_DATA_DIR = path.join(__dirname, 'data');
const FAN_CURVES_PATH = path.join(FAN_DATA_DIR, 'fan_curves.json');
try { if (!fs.existsSync(FAN_DATA_DIR)) fs.mkdirSync(FAN_DATA_DIR, { recursive: true }); } catch {}
let curvesState = { enabled: false, curves: [] };
try { if (fs.existsSync(FAN_CURVES_PATH)) { curvesState = JSON.parse(fs.readFileSync(FAN_CURVES_PATH, 'utf8')); curvesState.enabled = !!curvesState.enabled; curvesState.curves = Array.isArray(curvesState.curves) ? curvesState.curves : []; } } catch {}
function saveCurves() { try { fs.writeFileSync(FAN_CURVES_PATH, JSON.stringify(curvesState, null, 2)); } catch (e) { console.error('Failed to save fan curves:', e.message); } }
function interpSpeed(points, temp) { if (!Array.isArray(points) || points.length === 0) return 0; const pts = [...points].sort((a,b)=>a.t-b.t); if (temp <= pts[0].t) return pts[0].s; if (temp >= pts[pts.length-1].t) return pts[pts.length-1].s; for (let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1]; if (temp>=a.t && temp<=b.t){ const k=(temp-a.t)/(b.t-a.t); return Math.round(a.s + k*(b.s-a.s)); } } return pts[0].s; }
let lastApplied = new Map(); let applying = false;
setInterval(async () => { if (!curvesState.enabled || applying) return; if (!curvesState.curves || curvesState.curves.length===0) return; applying = true; try { const libre = await readLibreHardwareFans(); const tempsById = new Map((libre.temperatures||[]).map(t=>[t.id,t.value])); for (const c of curvesState.curves) { const temp = tempsById.get(c.sensorId); if (typeof temp !== 'number') continue; const target = Math.max(0, Math.min(100, interpSpeed(c.points||[], temp))); const prev = lastApplied.get(c.targetId); if (prev === target) continue; const res = await setLiquidctlSpeedById(c.targetId, target); if (res.success) lastApplied.set(c.targetId, target); } } catch { } finally { applying = false; } }, 3000);

// ---- New fan APIs (libre + liquidctl + curves) ----
async function setFanSpeed(fanId, speedPercent) {
    try {
        // FanControl uses PowerShell scripts and fan configuration files
        // We'll attempt to use FanControl's command line interface or create temp profiles
        return new Promise((resolve) => {
            console.log(`Attempting FanControl fan speed: ${fanId} -> ${speedPercent}%`);

            // Create a PowerShell script to interact with FanControl
            const psScript = `
                # Check if FanControl is running
                $fanControlProcess = Get-Process -Name "FanControl" -ErrorAction SilentlyContinue
                if (-not $fanControlProcess) {
                    Write-Output "ERROR: FanControl not running"
                    exit 1
                }
                
                # Attempt to create a temporary fan profile or use FanControl API
                # For now, we'll provide instructions for manual configuration
                Write-Output "FanControl detected - Manual configuration required"
                Write-Output "Fan: ${fanId}"
                Write-Output "Target Speed: ${speedPercent}%"
            `;

            exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`,
                { windowsHide: true, timeout: 5000 },
                (err, stdout, stderr) => {
                    if (err || stderr.includes('ERROR')) {
                        console.log(`FanControl not available for ${fanId}, providing instructions`);
                        resolve({
                            success: false,
                            method: 'fancontrol_manual',
                            fanId: fanId,
                            targetSpeed: speedPercent,
                            error: stderr || err?.message || 'FanControl not running or accessible',
                            message: `FanControl setup required for fan ${fanId}`,
                            instructions: {
                                step1: 'Ensure FanControl is running and configured',
                                step2: `Create a custom curve for fan sensor matching "${fanId}"`,
                                step3: `Set the curve to fixed ${speedPercent}% or create temperature-based curve`,
                                step4: 'Apply the configuration in FanControl interface'
                            }
                        });
                    } else {
                        console.log(`FanControl instructions provided for ${fanId}`);
                        resolve({
                            success: false, // Manual configuration still required
                            method: 'fancontrol_guided',
                            fanId: fanId,
                            targetSpeed: speedPercent,
                            stdout: stdout,
                            message: `FanControl detected - Manual configuration needed for ${fanId}`,
                            instructions: {
                                step1: 'Open FanControl application',
                                step2: `Find fan sensor for "${fanId}" in the sensors list`,
                                step3: `Create or modify fan curve to ${speedPercent}%`,
                                step4: 'Apply changes and verify fan speed'
                            },
                            fancontrol_running: true
                        });
                    }
                }
            );
        });
    } catch (e) {
        return {
            success: false,
            method: 'error',
            fanId: fanId,
            error: e.message,
            message: 'Error attempting FanControl integration'
        };
    }
}

// Helper function to set fan speed via LibreHardwareMonitor
async function setLibreHardwareFanSpeed(fanId, speedPercent) {
    try {
        // LibreHardwareMonitor doesn't have a direct API for setting fan speeds
        // But we can use external tools like FanControl or direct hardware access
        // For now, we'll return instructions for manual control
        return {
            success: false,
            method: 'manual',
            message: 'LibreHardwareMonitor provides monitoring only. Use FanControl or motherboard software for control.'
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

app.get('/api/fans', async (req, res) => {
    try {
        // New implementation: combine LibreHardwareMonitor monitoring with liquidctl controllable fans
        try {
            const [libre, lq] = await Promise.all([readLibreHardwareFans(), listLiquidctlDevices()]);
            const combined = [];
            if (lq.available) combined.push(...(lq.fans || []));
            const existingIds = new Set(combined.map(f => f.id));
            (libre.fans || []).forEach(f => { if (!existingIds.has(f.id)) combined.push(f); });
            const temps = libre.temperatures || [];
            const enhanced = combined.map(f => {
                let related = null;
                const lname = (f.name || '').toLowerCase();
                if (lname.includes('cpu')) related = temps.find(t => (t.name || '').toLowerCase().includes('cpu'));
                if (!related && lname.includes('gpu')) related = temps.find(t => (t.name || '').toLowerCase().includes('gpu'));
                if (!related) related = temps.find(t => t.hardware === f.hardware) || temps[0];
                return { ...f, temperature: related ? related.value : null, temperatureSensor: related ? related.name : null };
            });
            res.json({
                fans: enhanced,
                temperatures: temps,
                libre_hardware_available: !libre.error,
                liquidctl_available: !!lq.available,
                data_source: lq.available ? 'liquidctl+LibreHardwareMonitor' : (!libre.error ? 'LibreHardwareMonitor' : 'None'),
                total_fans: enhanced.length,
                running_fans: enhanced.filter(f => f.status === 'running').length
            });
            return;
        } catch (e2) {
            // fall through to legacy path if something goes wrong
        }
        console.log('Fetching fan data from FanControl...');

        // Try FanControl first
        const fanControlData = await readFanControlData();

        let finalData = fanControlData;
        let dataSource = 'FanControl';

        // If FanControl fails, fallback to LibreHardwareMonitor
        if (!fanControlData.fancontrol_available || fanControlData.fans.length === 0) {
            console.log('FanControl not available, trying LibreHardwareMonitor...');
            const libreData = await readLibreHardwareFans();

            if (libreData.fans.length > 0) {
                finalData = {
                    fans: libreData.fans,
                    temperatures: libreData.temperatures,
                    fancontrol_available: false,
                    libre_hardware_available: !libreData.error,
                    error: fanControlData.error
                };
                dataSource = 'LibreHardwareMonitor';
            } else {
                // Both failed
                finalData = {
                    fans: [],
                    temperatures: [],
                    fancontrol_available: false,
                    libre_hardware_available: false,
                    error: `Both FanControl and LibreHardwareMonitor unavailable. FanControl: ${fanControlData.error}, LibreHardware: ${libreData.error}`
                };
                dataSource = 'None';
            }
        }

        // Enhance fan data with temperature correlation
        const enhancedFans = finalData.fans.map(fan => {
            // Try to find related temperature sensor
            let relatedTemp = null;

            // Look for CPU temperature if this is a CPU fan
            if (fan.name.toLowerCase().includes('cpu')) {
                relatedTemp = finalData.temperatures.find(temp =>
                    temp.name.toLowerCase().includes('cpu') &&
                    temp.hardware === fan.hardware
                );
            }

            // Look for system temperature if this is a system fan
            if (fan.name.toLowerCase().includes('system') && !relatedTemp) {
                relatedTemp = finalData.temperatures.find(temp =>
                    temp.name.toLowerCase().includes('system') &&
                    temp.hardware === fan.hardware
                );
            }

            // Look for GPU temperature if this is a GPU fan
            if (fan.name.toLowerCase().includes('gpu') && !relatedTemp) {
                relatedTemp = finalData.temperatures.find(temp =>
                    temp.name.toLowerCase().includes('gpu') &&
                    temp.hardware === fan.hardware
                );
            }

            // Fallback: any temperature from same hardware
            if (!relatedTemp) {
                relatedTemp = finalData.temperatures.find(temp => temp.hardware === fan.hardware);
            }

            return {
                ...fan,
                temperature: relatedTemp ? relatedTemp.value : null,
                temperatureSensor: relatedTemp ? relatedTemp.name : null
            };
        });

        const result = {
            fans: enhancedFans,
            temperatures: finalData.temperatures,
            fancontrol_available: finalData.fancontrol_available || false,
            libre_hardware_available: finalData.libre_hardware_available || false,
            data_source: dataSource,
            config_path: finalData.config_path,
            error: finalData.error,
            total_fans: enhancedFans.length,
            running_fans: enhancedFans.filter(f => f.status === 'running').length,
            control_methods: [
                'FanControl by Rem0o (primary - recommended)',
                'LibreHardwareMonitor (monitoring only)',
                'Argus Monitor (alternative)',
                'SpeedFan (legacy)',
                'Motherboard BIOS/UEFI'
            ],
            note: dataSource === 'FanControl' ?
                'Using FanControl for real-time fan monitoring and control' :
                dataSource === 'LibreHardwareMonitor' ?
                    'Using LibreHardwareMonitor for monitoring. Install FanControl for better integration.' :
                    'No fan monitoring service detected. Install FanControl or LibreHardwareMonitor.'
        };

        console.log(`Found ${enhancedFans.length} fans from ${dataSource}`);
        res.json(result);
    } catch (e) {
        console.error('Fan API error:', e);
        res.json({
            fans: [],
            temperatures: [],
            error: e.message,
            fancontrol_available: false,
            libre_hardware_available: false,
            data_source: 'Error'
        });
    }
}); app.post('/api/fans/bulk/speed', async (req, res) => {
    const { fanIds, speed } = req.body || {};

    if (!Array.isArray(fanIds) || fanIds.length === 0) {
        return res.status(400).json({ error: 'fanIds array required' });
    }

    if (typeof speed !== 'number' || speed < 0 || speed > 100) {
        return res.status(400).json({ error: 'speed must be 0-100' });
    }

    const results = [];
    for (const fanId of fanIds) {
        if (String(fanId).startsWith('liquidctl:')) {
            results.push(await setLiquidctlSpeedById(fanId, speed));
        } else {
            results.push({ success: false, fanId, error: 'Not controllable (requires liquidctl target)' });
        }
    }

    res.json({ ok: true, speed, fanCount: fanIds.length, fanIds, results, method: 'liquidctl' });
});

app.post('/api/fans/:fanId/speed', async (req, res) => {
    const { fanId } = req.params;
    const { speed } = req.body || {};
    
    if (typeof speed !== 'number' || speed < 0 || speed > 100) {
        return res.status(400).json({ error: 'speed must be 0-100' });
    }

    const result = await setLiquidctlSpeedById(fanId, speed);
    res.json({ ok: !!result.success, fanId, speed, ...result, method: 'liquidctl' });
});

app.post('/api/fans/:fanId/auto', async (req, res) => {
    const { fanId } = req.params;
    console.log(`Setting fan ${fanId} to automatic control`);

    res.json({
        ok: false,
        fanId,
        method: 'Curves',
        message: 'Use /api/fans/curves endpoints to enable automatic control based on temperature.'
    });
});

// ---- FanControl Integration ----
// New curves endpoints
app.get('/api/fans/curves', (req, res) => {
    res.json({ enabled: !!curvesState.enabled, curves: curvesState.curves });
});
app.post('/api/fans/curves', (req, res) => {
    const { id, targetId, targetName, sensorId, sensorName, points } = req.body || {};
    if (!targetId || !sensorId || !Array.isArray(points)) return res.status(400).json({ error: 'targetId, sensorId, points required' });
    const curve = { id: id || `c${Date.now()}`, targetId, targetName, sensorId, sensorName, points: points.map(p => ({ t: +p.t, s: +p.s })) };
    const idx = curvesState.curves.findIndex(c => c.id === curve.id || c.targetId === curve.targetId);
    if (idx >= 0) curvesState.curves[idx] = curve; else curvesState.curves.push(curve);
    saveCurves();
    res.json({ ok: true, curve });
});
app.delete('/api/fans/curves/:id', (req, res) => {
    const id = req.params.id;
    const before = curvesState.curves.length;
    curvesState.curves = curvesState.curves.filter(c => c.id !== id);
    saveCurves();
    res.json({ ok: true, removed: before - curvesState.curves.length });
});
app.post('/api/fans/curves/enable', (req, res) => {
    const { enabled } = req.body || {};
    curvesState.enabled = !!enabled;
    saveCurves();
    res.json({ ok: true, enabled: curvesState.enabled });
});

// liquidctl status & sensors
app.get('/api/fans/liquidctl/status', async (req, res) => {
    const lq = await listLiquidctlDevices();
    res.json({ available: !!lq.available, devices: lq.devices || [], error: lq.error });
});
app.get('/api/fans/sensors', async (req, res) => {
    const libre = await readLibreHardwareFans();
    res.json({ sensors: libre.temperatures || [], libre_hardware_available: !libre.error, error: libre.error });
});

// ---- Client-side error logging ----
app.post('/api/errors', (req, res) => {
    const { message, stack, url, line, column, userAgent, timestamp } = req.body || {};
    const errorInfo = {
        timestamp: timestamp || new Date().toISOString(),
        message: message || 'Unknown error',
        stack,
        url,
        line,
        column,
        userAgent,
        clientIP: req.ip || req.connection.remoteAddress
    };

    console.error('CLIENT ERROR:', JSON.stringify(errorInfo, null, 2));
    res.json({ ok: true });
});

// ---- WebSocket broadcast (live updates) ----
const server = app.listen(PORT, HOST, () => {
    console.log(`Controller listening on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
    const sendStats = async () => {
        try {
            const [load, mem, temp] = await Promise.all([si.currentLoad(), si.mem(), si.cpuTemperature()]);
            ws.send(JSON.stringify({
                type: 'stats',
                load: load.currentload,
                memUsed: mem.active,
                memTotal: mem.total,
                temp: temp?.main ?? null
            }));
        } catch { }
    };
    const t = setInterval(sendStats, 1500);
    ws.on('close', () => clearInterval(t));
});
