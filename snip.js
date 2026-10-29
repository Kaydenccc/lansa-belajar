'use strict';

// Seret untuk memilih area; Esc atau klik kanan untuk batal. Koordinat dalam piksel CSS (= DIP display).
const sel = document.getElementById('sel');
const MIN_SIZE = 8;
let start = null;

function rectFrom(e) {
  return {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    width: Math.abs(e.clientX - start.x),
    height: Math.abs(e.clientY - start.y),
  };
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  document.body.classList.add('selecting');
  Object.assign(sel.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' });
  sel.hidden = false;
});

window.addEventListener('mousemove', (e) => {
  if (!start) return;
  const r = rectFrom(e);
  Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
});

window.addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  const r = rectFrom(e);
  start = null;
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
    // Klik tanpa seret: mulai ulang pilihan.
    sel.hidden = true;
    document.body.classList.remove('selecting');
    return;
  }
  window.snip.done(r);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.snip.done(null);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.snip.done(null);
});
