// Custom tooltip system - replaces native title tooltips with a DOM element
// that scales with webFrame.setZoomFactor. Native tooltips are chrome-layer
// widgets the zoom factor cannot reach, so they stay tiny on high-DPI displays.
// Uses event delegation on document so dynamically added elements are caught.
(function () {
    let tooltipEl = null;
    let currentEl = null;   // element we took the title from
    let titleText = '';     // the title text we removed
    let showTimer = null;
    let lastX = 0, lastY = 0;
    const SHOW_DELAY = 400; // match native tooltip feel

    function ensureEl() {
        if (tooltipEl) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'custom-tooltip';
        document.body.appendChild(tooltipEl);
        return tooltipEl;
    }

    function positionTooltip(x, y) {
        const el = ensureEl();
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.display = 'block';
        const rect = el.getBoundingClientRect();
        // Default: above the cursor, left-aligned
        let top = y - rect.height - 8;
        let left = x;
        // Flip below if no room above
        if (top < 4) top = y + 20;
        // Clamp horizontally
        if (left + rect.width > window.innerWidth - 4)
            left = window.innerWidth - rect.width - 4;
        if (left < 4) left = 4;
        el.style.top = top + 'px';
        el.style.left = left + 'px';
    }

    function showTooltip() {
        ensureEl();
        tooltipEl.textContent = titleText;
        positionTooltip(lastX, lastY);
    }

    function hideTooltip() {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (tooltipEl) tooltipEl.style.display = 'none';
        // Restore the native title so it works on next hover
        if (currentEl && titleText) {
            currentEl.setAttribute('title', titleText);
        }
        currentEl = null;
        titleText = '';
    }

    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest ? e.target.closest('[title]') : null;
        if (!el) return;
        const title = el.getAttribute('title');
        if (!title) return;
        // Already tracking this element - just update position
        if (currentEl === el) return;
        // Switch from a previous element
        hideTooltip();
        currentEl = el;
        titleText = title;
        // Remove native title to suppress the chrome-layer tooltip
        el.removeAttribute('title');
        showTimer = setTimeout(showTooltip, SHOW_DELAY);
    });

    document.addEventListener('mouseout', (e) => {
        if (!currentEl) return;
        const related = e.relatedTarget;
        // Still inside the titled element - do not hide
        if (related && currentEl.contains(related)) return;
        hideTooltip();
    });

    document.addEventListener('pointermove', (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        if (tooltipEl && tooltipEl.style.display !== 'none') {
            positionTooltip(lastX, lastY);
        }
    });

    // Hide on scroll, click, or Escape
    document.addEventListener('scroll', hideTooltip, true);
    document.addEventListener('click', hideTooltip);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideTooltip();
    });
})();
