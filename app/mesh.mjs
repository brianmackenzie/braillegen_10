// mesh.mjs — triangle-mesh construction and binary STL output.
//
// The sign maker builds its geometry directly as triangles (plates, extruded
// letter outlines, braille dots) — no CSG kernel. Each solid is a closed
// shell; shells may interpenetrate (a dot sinking into the plate), which FDM
// slicers merge per layer. This is the same multi-shell approach the tile
// generator's engine produces.
//
// Coordinates are millimetres, Z up, counter-clockwise winding seen from
// outside (the STL convention).
//
// AGPL-3.0 — part of the BrailleGen fork.

export class MeshBuilder {
  constructor() {
    /** @type {number[]} 9 numbers per triangle */
    this.t = [];
  }

  get triangleCount() { return this.t.length / 9; }

  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    this.t.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  /** Quad a-b-c-d (CCW from outside) as two triangles. */
  quad(a, b, c, d) {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  }

  /** Append every triangle of another builder. */
  merge(other) { this.t.push(...other.t); }

  /**
   * Extrude a triangulated flat region into a prism.
   *
   * @param {number[]} verts - flat [x0,y0, x1,y1, ...] in mm.
   * @param {number[]} triIndices - earcut-style index triples into verts,
   *   wound counter-clockwise for the +Z face.
   * @param {Array<number[]>} rings - boundary loops as vertex-index arrays:
   *   outer rings counter-clockwise, hole rings clockwise (side walls face
   *   outward for both when walked in ring order).
   * @param {number} z0 - bottom Z.
   * @param {number} z1 - top Z.
   */
  prism(verts, triIndices, rings, z0, z1) {
    const P = (i, z) => [verts[2 * i], verts[2 * i + 1], z];
    for (let i = 0; i < triIndices.length; i += 3) {
      const [a, b, c] = [triIndices[i], triIndices[i + 1], triIndices[i + 2]];
      // top face up
      this.tri(...P(a, z1), ...P(b, z1), ...P(c, z1));
      // bottom face down (reverse winding)
      this.tri(...P(a, z0), ...P(c, z0), ...P(b, z0));
    }
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        this.quad(P(a, z0), P(b, z0), P(b, z1), P(a, z1));
      }
    }
  }

  /**
   * A braille dot as a true spherical cap — ADA 703.3.1 and California
   * 11B-703.3.1 both require braille dots to have "a domed or rounded
   * shape", so the profile is the cap of the sphere through the base circle
   * and the apex (no flat top, no straight side).
   *
   * @param {number} cx @param {number} cy - centre (mm)
   * @param {number} z - base height (mm; sits ON this Z)
   * @param {number} radius - base radius (mm)
   * @param {number} height - dot height above z (mm)
   * @param {number} [segments=24] - radial resolution
   * @param {number} [rings=5] - latitude resolution
   */
  dot(cx, cy, z, radius, height, segments = 24, rings = 5) {
    // Sphere through the base circle (radius r at z) with its apex at z+h.
    const R = (radius * radius + height * height) / (2 * height);
    const zc = z + height - R;                       // sphere centre (below the base for h < R)
    const ringAt = (zz) => {
      const rr = Math.sqrt(Math.max(0, R * R - (zz - zc) * (zz - zc)));
      const pts = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a), zz]);
      }
      return pts;
    };
    const levels = [];
    for (let k = 0; k < rings; k++) {
      // Sine spacing puts more rings near the apex where curvature is highest.
      levels.push(ringAt(z + height * Math.sin((k / rings) * Math.PI / 2)));
    }
    const zTop = z + height;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const base = levels[0];
      // bottom disc (faces down)
      this.tri(cx, cy, z, base[j][0], base[j][1], z, base[i][0], base[i][1], z);
      // curved bands
      for (let k = 0; k + 1 < levels.length; k++) {
        this.quad(levels[k][i], levels[k][j], levels[k + 1][j], levels[k + 1][i]);
      }
      // apex fan
      const last = levels[levels.length - 1];
      this.tri(last[i][0], last[i][1], last[i][2], last[j][0], last[j][1], last[j][2], cx, cy, zTop);
    }
  }

  /**
   * Vertical cylinder wall only (no caps) — used for screw-hole bores, where
   * the plate's top/bottom faces already carry the hole rings.
   * Winding faces INWARD (toward the hole axis) so normals point into the bore.
   */
  holeWall(cx, cy, r, z0, z1, segments = 32) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
      const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      this.quad([p0[0], p0[1], z0], [p0[0], p0[1], z1], [p1[0], p1[1], z1], [p1[0], p1[1], z0]);
    }
  }
}

/**
 * Serialize triangles to binary STL (80-byte header, uint32 count, then
 * 50 bytes per triangle: normal, three vertices, attribute word).
 * Normals are computed from the winding.
 *
 * @param {number[]} t - flat triangle array (9 numbers per triangle)
 * @param {string} [name] - written into the header (ASCII, truncated)
 * @returns {Uint8Array}
 */
export function toBinaryStl(t, name = 'braillegen') {
  const n = t.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const header = new Uint8Array(buf, 0, 80);
  for (let i = 0; i < Math.min(79, name.length); i++) header[i] = name.charCodeAt(i) & 0x7F;
  view.setUint32(80, n, true);
  let off = 84;
  for (let i = 0; i < t.length; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
    const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(off, nx, true); view.setFloat32(off + 4, ny, true); view.setFloat32(off + 8, nz, true);
    for (let v = 0; v < 9; v++) view.setFloat32(off + 12 + v * 4, t[i + v], true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return new Uint8Array(buf);
}

/**
 * Parse a binary STL back to a flat triangle array — the preview renders
 * engine-generated tiles through the same viewer as sign meshes.
 * Returns null for ASCII STLs or malformed input.
 */
export function parseBinaryStl(bytes) {
  if (bytes.length < 84) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  if (84 + n * 50 !== bytes.length) return null;
  const t = new Float32Array(n * 9);
  let off = 84;
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 9; v++) t[i * 9 + v] = view.getFloat32(off + 12 + v * 4, true);
    off += 50;
  }
  return t;
}
