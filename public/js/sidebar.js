// sidebar.js: Handles sidebar navigation and collapse

document.addEventListener('DOMContentLoaded', function () {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = `
    <nav class="sidebar">
      <button id="sidebar-toggle">☰</button>
      <ul id="sidebar-links">
        <li><a href="/pages/dashboard.html"><span class="icon">🏠</span><span class="text">Dashboard</span></a></li>
        <li><a href="/pages/processes.html"><span class="icon">🗂️</span><span class="text">Processes</span></a></li>
        <li><a href="/pages/fans.html"><span class="icon">🌀</span><span class="text">Fans</span></a></li>
        <li><a href="/pages/system.html"><span class="icon">🖥️</span><span class="text">System</span></a></li>
      </ul>
    </nav>
  `;
    const nav = document.querySelector('.sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    toggle.addEventListener('click', () => {
        nav.classList.toggle('collapsed');
    });
});
