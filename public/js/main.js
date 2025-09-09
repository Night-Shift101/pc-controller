// main.js: Handles page-specific logic for each page

// ---- Global error handling ----
window.addEventListener('error', function (e) {
    const errorData = {
        message: e.message,
        stack: e.error ? e.error.stack : null,
        url: e.filename,
        line: e.lineno,
        column: e.colno,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
    };

    fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorData)
    }).catch(() => { }); // Silently fail if error logging fails
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', function (e) {
    const errorData = {
        message: 'Unhandled Promise Rejection: ' + (e.reason || 'Unknown'),
        stack: e.reason && e.reason.stack ? e.reason.stack : null,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
    };

    fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorData)
    }).catch(() => { });
});

// Dashboard: Fetch system summary
if (document.getElementById('sys-summary')) {
    fetch('/api/sys/summary')
        .then(r => r.json())
        .then(data => {
            document.getElementById('sys-summary').innerHTML = `
				<b>CPU:</b> ${data.cpu.brand} (${data.cpu.cores} cores, ${data.cpu.load.toFixed(1)}% load)<br>
				<b>Memory:</b> ${(data.mem.used / 1e9).toFixed(2)} GB / ${(data.mem.total / 1e9).toFixed(2)} GB<br>
				<b>OS:</b> ${data.os.platform} ${data.os.release}<br>
				<b>CPU Temp:</b> ${data.temp ? data.temp + '°C' : 'N/A'}
			`;
        })
        .catch(e => {
            document.getElementById('sys-summary').innerHTML = '<div>Error loading system data</div>';
            console.error('Dashboard error:', e);
        });
}

// Processes: Fetch and display process list
if (document.getElementById('proc-table')) {
    fetch('/api/processes')
        .then(r => r.json())
        .then(list => {
            const tbody = document.querySelector('#proc-table tbody');
            tbody.innerHTML = '';
            list.forEach(proc => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
					<td>${proc.pid}</td>
					<td>${proc.name}</td>
					<td>${proc.cpu.toFixed(1)}</td>
					<td>${proc.mem.toFixed(1)}</td>
					<td><button data-pid="${proc.pid}">Kill</button></td>
				`;
                tbody.appendChild(tr);
            });
            tbody.querySelectorAll('button[data-pid]').forEach(btn => {
                btn.onclick = () => {
                    if (confirm('Kill process ' + btn.dataset.pid + '?')) {
                        fetch(`/api/processes/${btn.dataset.pid}/kill`, { method: 'POST' })
                            .then(r => r.json())
                            .then(res => alert(res.ok ? 'Killed' : res.error));
                    }
                };
            });
        });
}

// Fans: Monitor and control with new UI
if (document.getElementById('fan-grid')) {
    let fanData = {};
    let selectedFans = new Set();
    let sensors = [];
    let curves = { enabled: false, curves: [] };

    // Load fan data
    function loadFanData() {
        Promise.all([
            fetch('/api/fans').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`); return r.json(); }),
            fetch('/api/fans/liquidctl/status').then(r => r.json()),
            fetch('/api/fans/sensors').then(r => r.json()),
            fetch('/api/fans/curves').then(r => r.json())
        ])
        .then(([fansRes, liquidctlStatus, sensorsRes, curvesRes]) => {
            fanData = fansRes;
            sensors = sensorsRes.sensors || [];
            curves = curvesRes || { enabled: false, curves: [] };
            displayFanCards(fanData);
            displayOverview(fanData);
            displayLiquidctlStatus(liquidctlStatus);
            displayControlInfo(fanData);
            initCurveEditor();
            updateControlPanel();
        })
        .catch(e => {
            console.error('Fan data error:', e);
            showStatusMessage(`Error loading fan data: ${e.message}`, 'error');
        });
    }

    // Display fan overview
    function displayOverview(data) {
        const overview = document.getElementById('fan-overview');
        const totalFans = data.fans ? data.fans.length : 0;
        const runningFans = data.running_fans || 0;
        
        const dataSourceInfo = data.data_source ? 
            `<div><strong>Data Source:</strong> ${data.data_source}</div>` : '';
        
        const fanControlStatus = data.fancontrol_available ? '✓ Running' : '✗ Not detected';
        const libreStatus = data.libre_hardware_available ? '✓ Connected' : '✗ Not detected';
        
        overview.innerHTML = `
            <div style="display: flex; gap: 2rem; margin: 1rem 0; flex-wrap: wrap;">
                <div><strong>Total Fans:</strong> ${totalFans}</div>
                <div><strong>Running:</strong> ${runningFans}</div>
                <div><strong>FanControl:</strong> ${fanControlStatus}</div>
                <div><strong>LibreHardwareMonitor:</strong> ${libreStatus}</div>
                <div><strong>liquidctl:</strong>  ${data.liquidctl_available ? ? Ready : ? Not detected}</div> 
                ${dataSourceInfo}
            </div>
        `;
    }

    // Display liquidctl status
    function displayLiquidctlStatus(status) {
        const fanControlDiv = document.getElementById('liquidctl-status');
        if (status.available && status.running) {
            fanControlDiv.innerHTML = `
                <div class="status-info">
                    ? liquidctl is available
                    <details style="margin-top: 0.5rem;">
                        <summary>Show process info</summary>
                        <pre style="margin: 0.5rem 0; padding: 0.5rem; background: #1a1a1a; border-radius: 4px;">${status.process_info}</pre>
                    </details>
                </div>
            `;
        } else {
            fanControlDiv.innerHTML = `
                <div class="status-warning">
                    ? liquidctl not found. Install via Python: <code>pip install liquidctl</code>
                    <div style="margin-top: 0.5rem; font-size: 0.9rem;">
                        Download: <a href="${status.download_link}" target="_blank">FanControl by Rem0o</a>
                    </div>
                </div>
            `;
        }
    }

    // Display fan cards
    function displayFanCards(data) {
        const grid = document.getElementById('fan-grid');
        
        // Store current selections before clearing
        const currentSelections = new Set(selectedFans);
        
        grid.innerHTML = '';

        if (!data.fans || data.fans.length === 0) {
            grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: #999;">No fans detected. Make sure LibreHardwareMonitor is running with web server enabled.</div>';
            return;
        }

        // Clear selectedFans and rebuild it from preserved selections
        selectedFans.clear();

        data.fans.forEach(fan => {
            const card = createFanCard(fan);
            
            // Restore selection state if this fan was previously selected
            if (currentSelections.has(fan.id)) {
                card.classList.add('selected');
                selectedFans.add(fan.id);
            }
            
            grid.appendChild(card);
        });
    }

    // Create individual fan card
    function createFanCard(fan) {
        const card = document.createElement('div');
        card.className = `fan-card ${fan.status === 'stopped' ? 'offline' : ''}`;
        card.dataset.fanId = fan.id;

        const statusClass = fan.status === 'running' ? 'running' : 
                           fan.status === 'stopped' ? 'stopped' : 'warning';

        card.innerHTML = `
            <div class="fan-header">
                <h4 class="fan-name">${fan.name}</h4>
                <span class="fan-status-badge ${statusClass}">${fan.status}</span>
            </div>
            <div class="fan-details">
                <div class="fan-metric">
                    <div class="fan-metric-label">RPM</div>
                    <div class="fan-metric-value">${fan.rpm || 'N/A'}</div>
                </div>
                <div class="fan-metric">
                    <div class="fan-metric-label">Temperature</div>
                    <div class="fan-metric-value">${fan.temperature ? fan.temperature.toFixed(1) + '°C' : 'N/A'}</div>
                </div>
            </div>
            <div class="fan-hardware">${fan.hardware}</div>
        `;

        // Click handler for selection
        card.addEventListener('click', () => {
            toggleFanSelection(fan.id, card);
        });

        return card;
    }

    // Toggle fan selection
    function toggleFanSelection(fanId, cardElement) {
        if (selectedFans.has(fanId)) {
            selectedFans.delete(fanId);
            cardElement.classList.remove('selected');
        } else {
            selectedFans.add(fanId);
            cardElement.classList.add('selected');
        }
        updateControlPanel();
    }

    // Update control panel visibility and state
    function updateControlPanel() {
        const controlPanel = document.getElementById('control-panel');
        const selectedCount = document.getElementById('selected-count');
        const applyBtn = document.getElementById('apply-speed-btn');
        const autoBtn = document.getElementById('auto-mode-btn');

        if (selectedFans.size > 0) {
            controlPanel.style.display = 'block';
            selectedCount.textContent = `${selectedFans.size} fan${selectedFans.size > 1 ? 's' : ''} selected`;
            applyBtn.disabled = false;
            autoBtn.disabled = false;
        } else {
            controlPanel.style.display = 'none';
            applyBtn.disabled = true;
            autoBtn.disabled = true;
        }
    }

    // Display control information
    function displayControlInfo(data) {
        const controlInfo = document.getElementById('control-info');
        let html = '';

        // Show data source status
        if (data.data_source) {
            if (data.data_source === 'FanControl') {
                html += '<div class="status-info">✓ Using FanControl - Full monitoring and control available</div>';
            } else if (data.data_source === 'LibreHardwareMonitor') {
                html += '<div class="status-warning">⚠ Using LibreHardwareMonitor - Monitoring only. Install FanControl for control.</div>';
            } else if (data.data_source === 'None') {
                html += '<div class="status-warning">⚠ No monitoring service detected. Install FanControl or LibreHardwareMonitor.</div>';
            }
        }

        // FanControl status
        if (data.fancontrol_available) {
            html += '<div class="status-info">✓ FanControl detected - Real-time monitoring and control available</div>';
            if (data.config_path) {
                html += `<div style="font-size: 0.9rem; margin-top: 0.5rem;">Config path: ${data.config_path}</div>`;
            }
        } else {
            html += '<div class="status-warning">⚠ FanControl not detected. Download and run FanControl for the best experience.</div>';
        }

        // LibreHardwareMonitor status
        if (data.libre_hardware_available) {
            html += '<div class="status-info">✓ LibreHardwareMonitor detected - Hardware monitoring available</div>';
        } else if (!data.fancontrol_available) {
            html += '<div class="status-warning">⚠ LibreHardwareMonitor not detected. Install and run with web server enabled as fallback.</div>';
        }

        if (data.control_methods) {
            html += '<div><h4>Available Control Methods:</h4><ul>';
            data.control_methods.forEach(method => {
                html += `<li>${method}</li>`;
            });
            html += '</ul></div>';
        }

        if (data.note) {
            html += `<div style="margin-top: 1rem; font-style: italic;">${data.note}</div>`;
        }

        controlInfo.innerHTML = html;
    }

    // Show status message
    function showStatusMessage(message, type = 'info') {
        const statusDiv = document.getElementById('status-message');
        statusDiv.className = `status-${type}`;
        statusDiv.textContent = message;
        statusDiv.style.display = 'block';
        
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    }

    // Control panel event handlers
    const speedSlider = document.getElementById('fan-speed-slider');
    const speedValue = document.getElementById('fan-speed-value');
    const applyBtn = document.getElementById('apply-speed-btn');
    const autoBtn = document.getElementById('auto-mode-btn');
    const clearBtn = document.getElementById('clear-selection-btn');
    const controlResult = document.getElementById('control-result');

    // Update speed display
    speedSlider.addEventListener('input', () => {
        speedValue.textContent = speedSlider.value;
    });

    // Apply speed to selected fans
    applyBtn.addEventListener('click', () => {
        const fanIds = Array.from(selectedFans);
        const speed = parseInt(speedSlider.value);

        if (fanIds.length === 0) return;

        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying...';

        fetch('/api/fans/bulk/speed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fanIds, speed })
        })
        .then(r => r.json())
        .then(res => {
            controlResult.innerHTML = `
                <div class="status-info">
                    <strong>Control Request Sent</strong><br>
                    ${res.message}<br>
                    <small>Fans: ${fanIds.join(', ')} → ${speed}%</small>
                </div>
            `;
            showStatusMessage(res.message, 'info');
        })
        .catch(e => {
            controlResult.innerHTML = `<div class="status-warning">Error: ${e.message}</div>`;
        })
        .finally(() => {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply Speed';
        });
    });

    // Return to auto mode
    autoBtn.addEventListener('click', () => {
        const fanIds = Array.from(selectedFans);
        if (fanIds.length === 0) return;

        showStatusMessage('Auto mode requires manual configuration in fan control software', 'info');
        controlResult.innerHTML = `
            <div class="status-info">
                <strong>Auto Mode Request</strong><br>
                Please configure automatic fan curves in your fan control software for fans: ${fanIds.join(', ')}
            </div>
        `;
    });

    // Clear selection
    clearBtn.addEventListener('click', () => {
        selectedFans.clear();
        document.querySelectorAll('.fan-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        updateControlPanel();
        controlResult.innerHTML = '';
    });

    // FanControl integration event handlers
    });

    // Curves editor elements and helpers
    const curvesEnabled = document.getElementById('curves-enabled');
    const curveTarget = document.getElementById('curve-target');
    const curveSensor = document.getElementById('curve-sensor');
    const curvePoints = document.getElementById('curve-points');
    const curveAddPoint = document.getElementById('curve-add-point');
    const curveSave = document.getElementById('curve-save');
    const curveRemove = document.getElementById('curve-remove');
    const curveResult = document.getElementById('curve-result');

    function renderCurvePoints(points = [ { t: 30, s: 30 }, { t: 45, s: 50 }, { t: 65, s: 80 }, { t: 80, s: 100 } ]) {
        if (!curvePoints) return;
        curvePoints.innerHTML = '';
        points.forEach((p, idx) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.gap = '0.5rem';
            row.innerHTML = `
                <label>Temp °C <input type="number" data-idx="${idx}" data-key="t" value="${p.t}" style="width:80px;"></label>
                <label>Speed % <input type="number" data-idx="${idx}" data-key="s" value="${p.s}" style="width:80px;"></label>
            `;
            curvePoints.appendChild(row);
        });
    }
    function collectCurvePoints() {
        const inputs = curvePoints ? curvePoints.querySelectorAll('input') : [];
        const pts = [];
        inputs.forEach(inp => {
            const idx = parseInt(inp.getAttribute('data-idx'));
            const key = inp.getAttribute('data-key');
            if (!pts[idx]) pts[idx] = { t: 0, s: 0 };
            pts[idx][key] = parseInt(inp.value);
        });
        return pts.filter(Boolean).sort((a,b)=>a.t-b.t);
    }
    function initCurveEditor() {
        if (!curveTarget || !curveSensor) return;
        // liquidctl targets
        const liquidFans = (fanData.fans || []).filter(f => f.source === 'liquidctl');
        curveTarget.innerHTML = '';
        liquidFans.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = `${f.name} (${f.id})`;
            curveTarget.appendChild(opt);
        });
        // sensors
        curveSensor.innerHTML = '';
        (sensors || []).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${s.name} (${s.hardware})`;
            curveSensor.appendChild(opt);
        });
        if (curvesEnabled) curvesEnabled.checked = !!(curves && curves.enabled);
        const loadSelected = () => {
            const c = (curves.curves || []).find(x => x.targetId === curveTarget.value);
            if (c) { curveSensor.value = c.sensorId; renderCurvePoints(c.points || []); }
            else { renderCurvePoints(); }
        };
        curveTarget.onchange = loadSelected;
        loadSelected();
    }
    curvesEnabled?.addEventListener('change', () => {
        fetch('/api/fans/curves/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: curvesEnabled.checked }) })
            .then(r => r.json()).then(res => showStatusMessage(`Curves ${res.enabled ? 'enabled' : 'disabled'}`))
            .catch(e => showStatusMessage(`Failed to toggle curves: ${e.message}`, 'error'));
    });
    curveAddPoint?.addEventListener('click', () => {
        const pts = collectCurvePoints();
        pts.push({ t: (pts.at(-1)?.t || 80) + 5, s: 100 });
        renderCurvePoints(pts);
    });
    curveSave?.addEventListener('click', () => {
        const targetId = curveTarget.value;
        const targetName = curveTarget.selectedOptions[0]?.textContent;
        const sensorId = curveSensor.value;
        const sensorName = curveSensor.selectedOptions[0]?.textContent;
        const points = collectCurvePoints();
        fetch('/api/fans/curves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId, targetName, sensorId, sensorName, points }) })
            .then(r => r.json()).then(() => { if (curveResult) curveResult.innerHTML = '<div class="status-info">Curve saved.</div>'; showStatusMessage('Curve saved'); })
            .catch(e => { if (curveResult) curveResult.innerHTML = `<div class="status-warning">${e.message}</div>`; });
    });
    curveRemove?.addEventListener('click', () => {
        const c = (curves.curves || []).find(x => x.targetId === curveTarget.value);
        if (!c) { if (curveResult) curveResult.innerHTML = '<div class="status-warning">No existing curve</div>'; return; }
        fetch(`/api/fans/curves/${encodeURIComponent(c.id)}`, { method: 'DELETE' })
            .then(r => r.json()).then(() => { if (curveResult) curveResult.innerHTML = '<div class="status-info">Curve removed.</div>'; showStatusMessage('Curve removed'); })
            .catch(e => { if (curveResult) curveResult.innerHTML = `<div class="status-warning">${e.message}</div>`; });
    });

    // Load data on page load
    loadFanData();
    
    // Refresh data every 5 seconds
    setInterval(loadFanData, 5000);
}

// System: Actions and volume
window.systemAction = function (action) {
    fetch(`/api/system/${action}`, { method: 'POST' })
        .then(r => r.json())
        .then(res => alert(res.ok ? `${action} command sent` : res.error));
};
if (document.getElementById('volume-form')) {
    const slider = document.getElementById('volume-slider');
    const value = document.getElementById('volume-value');
    slider.oninput = () => value.textContent = slider.value;
    document.getElementById('volume-form').onsubmit = function (e) {
        e.preventDefault();
        fetch('/api/system/volume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level: +slider.value })
        })
            .then(r => r.json())
            .then(res => {
                document.getElementById('volume-result').textContent = res.ok ? 'Volume set!' : res.error;
            });
    };
}
