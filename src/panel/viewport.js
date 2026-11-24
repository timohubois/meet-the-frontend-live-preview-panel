// Fixed CSS viewport geometry; the surrounding canvas changes only its visual zoom.
export function createPreviewViewport(container, stage, dimensions, saved = {}, onChange = () => {}, deviceLabels = {
    desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone',
}) {
    const mainWindow = container.ownerDocument.defaultView;
    const canvas = container.querySelector('.mtflpp-canvas');
    const space = container.querySelector('.mtflpp-canvas-space');
    const dimensionText = dimensions.querySelector('.mtflpp-dimensions-text');
    const sizes = { desktop: [1280, 800], tablet: [768, 1024], mobile: [390, 844] };
    const presets = Object.keys(sizes);
    let device = presets.includes(saved.device) ? saved.device : 'desktop';
    const fits = ['automatic', 'window', 'width', 'custom'];
    let fit = fits.includes(saved.fit) ? saved.fit : 'automatic';
    const maxCustomZoom = 400;
    const validZoom = (value) => Number.isInteger(value) && value >= 10 && value <= maxCustomZoom;
    let customZoom = validZoom(saved.customZoom) ? saved.customZoom : 100;
    let zoomPercent = 100;
    let lastDpr;
    const defaultOrientation = (name) => name === 'desktop' ? 'landscape' : 'portrait';
    const orientations = Object.fromEntries(presets.map((name) => [
        name, name !== 'desktop' && ['portrait', 'landscape'].includes(saved[`${name}Orientation`])
            ? saved[`${name}Orientation`] : defaultOrientation(name),
    ]));
    const size = () => orientations[device] === defaultOrientation(device) ? sizes[device] : [...sizes[device]].reverse();
    // Width fitting is explicit; Auto always keeps the whole screen visible.
    const widthFirst = () => fit === 'width';
    let scale;
    let animation;
    let removeResolutionListener;
    const motion = mainWindow.matchMedia('(prefers-reduced-motion: no-preference)');

    function pixelRatio() {
        const ratio = container.ownerDocument.defaultView.devicePixelRatio;
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }

    function scaleFor(width, height) {
        if (fit === 'custom') return customZoom / 100 / pixelRatio();
        const widthScale = canvas.clientWidth / width;
        if (widthFirst()) return widthScale;
        const windowScale = Math.min(widthScale, canvas.clientHeight / height);
        // 100% is one physical screen pixel per viewport CSS pixel, not native CSS zoom.
        return fit === 'automatic' ? Math.min(1 / pixelRatio(), windowScale) : windowScale;
    }

    function paint(value, pan) {
        scale = value;
        const [width, height] = size();
        const left = Math.max(0, (canvas.clientWidth - width * scale) / 2);
        const top = Math.max(0, (canvas.clientHeight - height * scale) / 2);
        // Clip the stage's untransformed layout box so it cannot create phantom scroll ranges.
        Object.assign(space.style, {
            width: `${Math.max(canvas.clientWidth, left + width * scale)}px`,
            height: `${Math.max(canvas.clientHeight, top + height * scale)}px`,
        });
        Object.assign(stage.style, {
            left: `${left}px`, top: `${top}px`, transform: `scale(${scale})`,
        });
        const overflow = width * scale > canvas.clientWidth + 0.01 || height * scale > canvas.clientHeight + 0.01;
        const navigable = fit === 'custom' || widthFirst();
        canvas.tabIndex = navigable && overflow ? 0 : -1;
        canvas.scrollLeft = fit === 'custom' ? pan.x * scale : 0;
        canvas.scrollTop = navigable ? pan.y * scale : 0;
    }

    function stopAnimation() {
        if (!animation) return;
        animation.window.cancelAnimationFrame(animation.frame);
        animation = null;
    }

    function render(animate = false, resetPan = false) {
        stopAnimation();
        const [width, height] = size();
        // Establish geometry even before the panel is measurable, so a loading page
        // never bootstraps its responsive scripts in an unsized iframe.
        Object.assign(stage.style, { width: `${width}px`, height: `${height}px` });
        if (!container.clientWidth || !container.clientHeight) return;
        const dpr = pixelRatio();
        const label = `${deviceLabels[device]} (${width} × ${height}) · `;
        // Fitting cannot exceed the width scale before scrollbars. This bound doesn’t depend on footer height.
        const maxZoom = Math.max(maxCustomZoom, Math.ceil(container.clientWidth / width * dpr * 100));
        const reserve = `${label}${'0'.repeat(String(maxZoom).length)}%`;
        if (dimensions.dataset.reserve !== reserve) dimensions.dataset.reserve = reserve;
        const pan = resetPan ? { x: 0, y: 0 } : {
            x: (canvas.scrollLeft || 0) / (scale || 1), y: (canvas.scrollTop || 0) / (scale || 1),
        };
        canvas.style.overflowX = 'hidden';
        canvas.style.overflowY = 'hidden';
        if (fit === 'custom') {
            // Fixed zoom must never shrink to fit. Reserve both native gutters before
            // painting; adding either scrollbar can make the other axis overflow too.
            const target = scaleFor(width, height);
            for (let pass = 0; pass < 2; pass++) {
                if (width * target > canvas.clientWidth + 0.01) canvas.style.overflowX = 'scroll';
                if (height * target > canvas.clientHeight + 0.01) canvas.style.overflowY = 'scroll';
            }
        } else if (widthFirst()) {
            // Decide from the unobstructed canvas, before its native gutter narrows the
            // available width. This keeps width-first fitting stable at the height limit.
            if (height * scaleFor(width, height) > container.clientHeight) canvas.style.overflowY = 'scroll';
        }
        if (!canvas.clientWidth || !canvas.clientHeight) return;
        const target = scaleFor(width, height);
        const nextZoom = Math.round(target * dpr * 100);
        const changed = nextZoom !== zoomPercent || dpr !== lastDpr;
        zoomPercent = nextZoom;
        lastDpr = dpr;
        const text = `${label}${fit === 'custom' ? customZoom : zoomPercent}%`;
        if (dimensionText.textContent !== text) dimensionText.textContent = text;
        if (changed) onChange();
        const from = scale ?? target;
        if (!animate || !motion.matches || from === target) {
            paint(target, pan);
            return;
        }
        // Animate only the camera, never the iframe's CSS width, height or aspect ratio.
        const current = { window: container.ownerDocument.defaultView, frame: null };
        const started = current.window.performance.now();
        animation = current;
        paint(from, pan);
        const step = (now) => {
            if (animation !== current) return;
            const progress = Math.min(1, Math.max(0, (now - started) / 200));
            const eased = 1 - (1 - progress) ** 3;
            paint(from + (target - from) * eased, pan);
            if (progress < 1) current.frame = current.window.requestAnimationFrame(step);
            else animation = null;
        };
        current.frame = current.window.requestAnimationFrame(step);
    }

    function layout() { render(); }

    function updatePixelRatio() {
        removeResolutionListener?.();
        const query = container.ownerDocument.defaultView.matchMedia(`(resolution: ${pixelRatio()}dppx)`);
        query.addEventListener('change', updatePixelRatio);
        removeResolutionListener = () => query.removeEventListener('change', updatePixelRatio);
        layout();
    }

    let observer = new mainWindow.ResizeObserver(layout);
    observer.observe(container);
    motion.addEventListener('change', layout);
    mainWindow.addEventListener('resize', updatePixelRatio);
    updatePixelRatio();

    return {
        get device() { return device; },
        get fit() { return fit; },
        get customZoom() { return customZoom; },
        get zoomPercent() { return fit === 'custom' ? customZoom : zoomPercent; },
        get dpr() { return pixelRatio(); },
        get orientation() { return orientations[device]; },
        select(name, animate = false) {
            if (!presets.includes(name)) return;
            const changed = device !== name;
            device = name;
            if (changed) render(animate, true);
            else if (!animation) layout();
        },
        rotate(animate = false) {
            if (device === 'desktop') return;
            orientations[device] = orientations[device] === 'portrait' ? 'landscape' : 'portrait';
            render(animate, true);
        },
        setFit(value) {
            if (!fits.includes(value) || fit === value) return;
            fit = value;
            render(false, true);
        },
        setZoom(value) {
            if (!validZoom(value) || (fit === 'custom' && customZoom === value)) return;
            const changedMode = fit !== 'custom';
            customZoom = value;
            fit = 'custom';
            render(false, changedMode);
        },
        layout,
        beforeMove() {
            stopAnimation();
            observer.disconnect();
            removeResolutionListener?.();
            container.ownerDocument.defaultView.removeEventListener('resize', updatePixelRatio);
        },
        afterMove() {
            observer = new container.ownerDocument.defaultView.ResizeObserver(layout);
            observer.observe(container);
            container.ownerDocument.defaultView.addEventListener('resize', updatePixelRatio);
            updatePixelRatio();
        },
    };
}
