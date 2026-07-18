// viewer.mjs — a small, dependency-free WebGL viewer for STL previews.
//
// Renders the app's own triangle buffers (flat-shaded, orbitable), so what
// you see is byte-for-byte what downloads. Renders on demand — no animation
// loop — and works from the keyboard: arrow keys orbit, + and - zoom,
// Home resets. Screen-reader users get the model description through the
// canvas label; the geometry facts live in the visible summary next to it.
//
// AGPL-3.0 — part of the BrailleGen fork.

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMvp;
uniform mat3 uNormal;
varying vec3 vNormal;
void main() {
  vNormal = uNormal * aNormal;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, normalize(vec3(0.35, 0.3, 0.9))), 0.0);
  float glow = 0.35 + 0.65 * diff;
  gl_FragColor = vec4(uColor * glow, 1.0);
}`;

// --- minimal matrix helpers (column-major mat4) ---
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function lookAtOrbit(cx, cy, cz, dist, yaw, pitch) {
  // camera position on the orbit sphere
  const ex = cx + dist * Math.cos(pitch) * Math.sin(yaw);
  const ey = cy - dist * Math.cos(pitch) * Math.cos(yaw);
  const ez = cz + dist * Math.sin(pitch);
  // basis
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  const zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
  // world up = +Z (prints stand on the build plate); x = normalize(up × z)
  let xx = -zy, xy = zx, xz = 0;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  // y = cross(z, x)
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return {
    view: [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1],
    eye: [ex, ey, ez],
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts]
 * @param {string} [opts.label] - accessible name for the canvas.
 * @returns {{ setMesh(tris: ArrayLike<number>): void, setColor(rgb: number[]): void,
 *             resize(): void, destroy(): void, supported: boolean }}
 */
export function createViewer(canvas, opts = {}) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true })
    || canvas.getContext('experimental-webgl');
  if (!gl) return { supported: false, setMesh() {}, setColor() {}, resize() {}, destroy() {} };

  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-roledescription', '3D model viewer');
  if (opts.label) canvas.setAttribute('aria-label', opts.label);
  canvas.tabIndex = 0;

  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.enable(gl.DEPTH_TEST);

  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aNormal = gl.getAttribLocation(prog, 'aNormal');
  const uMvp = gl.getUniformLocation(prog, 'uMvp');
  const uNormalM = gl.getUniformLocation(prog, 'uNormal');
  const uColor = gl.getUniformLocation(prog, 'uColor');

  const posBuf = gl.createBuffer();
  const nrmBuf = gl.createBuffer();

  const state = {
    count: 0,
    center: [0, 0, 0],
    radius: 50,
    yaw: 0.6, pitch: 0.5, dist: 150,
    color: [0.62, 0.66, 0.94],
    destroyed: false,
  };

  function setMesh(tris) {
    const t = tris instanceof Float32Array ? tris : new Float32Array(tris);
    // per-face normals, replicated per-vertex (flat shading without extensions)
    const normals = new Float32Array(t.length);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let v = 0; v < 3; v++) {
        normals[i + v * 3] = nx; normals[i + v * 3 + 1] = ny; normals[i + v * 3 + 2] = nz;
        const x = t[i + v * 3], y = t[i + v * 3 + 1], z = t[i + v * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    state.count = t.length / 3;
    state.center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    state.radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
    state.dist = state.radius * 2.6;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, t, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    resize();
  }

  function setColor(rgb) { state.color = rgb; render(); }

  function render() {
    if (state.destroyed || !state.count) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(0.9, aspect, state.radius / 50, state.dist + state.radius * 4);
    const { view } = lookAtOrbit(...state.center, state.dist, state.yaw, state.pitch);
    const mvp = mul(proj, view);
    gl.uniformMatrix4fv(uMvp, false, new Float32Array(mvp));
    // normals rotate with the view's rotational part
    gl.uniformMatrix3fv(uNormalM, false, new Float32Array([
      view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10],
    ]));
    gl.uniform3fv(uColor, state.color);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, state.count);
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    render();
  }

  const clampPitch = () => {
    state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch));
  };

  // --- pointer orbit + wheel zoom ---
  let dragging = false, lastX = 0, lastY = 0;
  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!dragging) return;
    state.yaw += (e.clientX - lastX) * 0.01;
    state.pitch += (e.clientY - lastY) * 0.01;
    clampPitch();
    lastX = e.clientX; lastY = e.clientY;
    render();
  };
  const onUp = () => { dragging = false; };
  const onWheel = (e) => {
    e.preventDefault();
    state.dist *= e.deltaY > 0 ? 1.1 : 0.9;
    state.dist = Math.max(state.radius * 1.1, Math.min(state.radius * 12, state.dist));
    render();
  };
  const onKey = (e) => {
    const step = 0.15;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': state.yaw -= step; break;
      case 'ArrowRight': state.yaw += step; break;
      case 'ArrowUp': state.pitch += step; break;
      case 'ArrowDown': state.pitch -= step; break;
      case '+': case '=': state.dist = Math.max(state.radius * 1.1, state.dist * 0.85); break;
      case '-': case '_': state.dist = Math.min(state.radius * 12, state.dist * 1.18); break;
      case 'Home': case '0': state.yaw = 0.6; state.pitch = 0.5; state.dist = state.radius * 2.6; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); clampPitch(); render(); }
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);

  // Single-tap controls: WCAG 2.5.7 requires a non-dragging pointer path for
  // rotation, so the page can wire plain buttons to these.
  function rotate(dyaw, dpitch) {
    state.yaw += dyaw; state.pitch += dpitch;
    clampPitch(); render();
  }
  function zoom(factor) {
    state.dist = Math.max(state.radius * 1.1, Math.min(state.radius * 12, state.dist * factor));
    render();
  }
  function reset() {
    state.yaw = 0.6; state.pitch = 0.5; state.dist = state.radius * 2.6;
    render();
  }

  return {
    supported: true,
    setMesh,
    setColor,
    rotate,
    zoom,
    reset,
    resize,
    destroy() {
      state.destroyed = true;
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
    },
  };
}
