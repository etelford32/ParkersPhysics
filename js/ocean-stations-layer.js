/** NOAA tide-gauge, marine buoy, and DART marker layers for EarthView. */

import { REFERENCE_STATIONS } from './ocean-reference-stations.js';

const TIDES_URL = '/api/ocean/tides?mode=stations';
const BUOYS_URL = '/api/ocean/buoys?mode=stations';
const DART_URL  = '/api/ocean/dart?mode=stations';
const KINDS = ['tides', 'buoys', 'dart'];

// Honest, geometry-only defaults used when NOAA cannot be reached — the ONE
// copy lives in js/ocean-reference-stations.js and the /api/ocean/* routes
// serve the SAME markers (flagged, `freshness: 'stale'`) when THEY cannot
// reach NOAA. This local copy is only for the case where our own route is
// unreachable (network down, 5xx). Every item is flagged so the detail card
// can say that plainly. A failed feed should still prove that the toggle and
// map layer work instead of leaving the user staring at no change.
const FALLBACK_STATIONS = REFERENCE_STATIONS;

/**
 * @returns {{ stations:object[], freshness:'live'|'stale', reason?:string, detail?:string }}
 *   A `freshness: 'stale'` body is the route's own degraded answer (reference
 *   markers) and is reported as 'fallback' by _load below — a down feed must
 *   look down even when the HTTP status is 200.
 */
async function fetchStations(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.detail ?? body.error);
    return {
        stations:  body.stations ?? [],
        freshness: body.freshness === 'stale' ? 'stale' : 'live',
        reason:    body.reason ?? null,
        detail:    body.detail ?? body.note ?? null,
    };
}

export class OceanStationsLayer {
    constructor(THREE, parent, { geoToXYZ, onStatus, forceFallback = false } = {}) {
        this.THREE = THREE;
        this.parent = parent;
        this.geoToXYZ = geoToXYZ;
        this.onStatus = onStatus ?? (() => {});
        this.forceFallback = Boolean(forceFallback);
        this._items = { tides: [], buoys: [], dart: [] };
        this._meshes = { tides: null, buoys: null, dart: null };
        this._wanted = { tides: false, buoys: false, dart: false };
        this._loading = { tides: null, buoys: null, dart: null };
        this._dummy = new THREE.Object3D();
    }

    setTidesVisible(visible) { return this._setVisible('tides', visible); }
    setBuoysVisible(visible) { return this._setVisible('buoys', visible); }
    setDartVisible(visible) { return this._setVisible('dart', visible); }
    isTidesVisible() { return this._meshes.tides?.visible ?? this._wanted.tides; }
    isBuoysVisible() { return this._meshes.buoys?.visible ?? this._wanted.buoys; }
    isDartVisible() { return this._meshes.dart?.visible ?? this._wanted.dart; }

    async _setVisible(kind, visible) {
        this._wanted[kind] = Boolean(visible);
        if (this._meshes[kind]) this._meshes[kind].visible = this._wanted[kind];
        if (!visible || this._meshes[kind]) return;
        if (!this._loading[kind]) this._loading[kind] = this._load(kind);
        return this._loading[kind];
    }

    async _load(kind) {
        this.onStatus(kind, 'fetching');
        try {
            if (this.forceFallback) throw new Error('locally forced fallback verification');
            const endpoint = kind === 'tides' ? TIDES_URL : kind === 'buoys' ? BUOYS_URL : DART_URL;
            const { stations: items, freshness, detail } = await fetchStations(endpoint);
            if (!items.length) throw new Error('upstream returned no station locations');
            this._items[kind] = items;
            this._meshes[kind] = this._buildMesh(kind, items);
            this._meshes[kind].visible = this._wanted[kind];
            // The route answered 200 but with its reference markers: NOAA
            // was unreachable from the server. Amber, same as a local miss.
            if (freshness === 'stale') {
                this.onStatus(kind, 'fallback', { count: items.length, error: detail ?? 'NOAA unreachable', server: true });
            } else {
                this.onStatus(kind, 'loaded', { count: items.length });
            }
        } catch (error) {
            const items = FALLBACK_STATIONS[kind];
            this._items[kind] = items;
            this._meshes[kind] = this._buildMesh(kind, items);
            this._meshes[kind].visible = this._wanted[kind];
            this.onStatus(kind, 'fallback', { count: items.length, error: error.message });
        }
    }

    _buildMesh(kind, items) {
        const geometry = kind === 'tides'
            ? new this.THREE.SphereGeometry(1, 7, 6)
            : kind === 'buoys'
                ? new this.THREE.OctahedronGeometry(1, 0)
                : new this.THREE.TetrahedronGeometry(1, 0);
        const material = new this.THREE.MeshBasicMaterial({
            color: kind === 'tides' ? 0x00d4ff : kind === 'buoys' ? 0xffcc44 : 0xff4d9d,
            transparent: true,
            opacity: 1,
            blending: this.THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new this.THREE.InstancedMesh(geometry, material, items.length);
        // EarthView's cloud/aurora/atmosphere stack reaches radius 1.026.
        // Stations must sit above it or a successful feed load is visually
        // buried beneath the weather shells. At these sizes a marker reads as
        // roughly 5–7 CSS px on the default desktop globe: conspicuous when
        // requested, but not a blanket over the coastline.
        const scale = kind === 'tides' ? 0.010 : kind === 'buoys' ? 0.012 : 0.014;
        for (let i = 0; i < items.length; i++) {
            this._dummy.position.copy(this.geoToXYZ(items[i].lat, items[i].lon)).multiplyScalar(1.032);
            this._dummy.scale.setScalar(scale);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(i, this._dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.name = kind === 'tides' ? 'ocean-tide-gauges'
            : kind === 'buoys' ? 'ocean-buoys' : 'ocean-dart-tsunameters';
        mesh.userData.oceanStationLayer = kind;
        mesh.renderOrder = 25;
        this.parent.add(mesh);
        return mesh;
    }

    getHovered(raycaster) {
        const hits = [];
        for (const kind of KINDS) {
            const mesh = this._meshes[kind];
            if (!mesh?.visible) continue;
            const hit = raycaster.intersectObject(mesh)[0];
            if (hit?.instanceId == null) continue;
            const data = this._items[kind][hit.instanceId];
            if (data) hits.push({
                distance: hit.distance,
                kind: kind === 'tides' ? 'tide' : kind === 'buoys' ? 'buoy' : 'dart',
                data,
            });
        }
        hits.sort((a, b) => a.distance - b.distance);
        return hits[0] ?? null;
    }
}
