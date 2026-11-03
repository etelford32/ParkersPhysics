/**
 * moon-landing-sites.js — Apollo + Artemis III candidate + colony-shortlist markers.
 *
 * Mounted as child meshes of the MoonSkin.moonMesh so markers rotate with
 * the Moon and inherit its world-space transform. Each marker is a small
 * colored sphere slightly raised above the surface (r = 1.005 on a unit
 * Moon) with an additive halo for visibility against the shaded regolith.
 *
 * Intentionally lightweight — no raycasting, no HTML overlays. The
 * info-panel carries the per-site coordinates + context; the globe just
 * marks the positions visibly.
 */

import * as THREE from 'three';
import { APOLLO_SITES, ARTEMIS_III_CANDIDATES, latLonToXYZ } from './artemis-data.js';
import { colonyShortlist } from './mission-pads.js';

const APOLLO_COLOR          = 0xffae44;  // amber — continuity with Apollo programme aesthetic
const ARTEMIS_COLOR         = 0x44ccff;  // cyan  — forward-looking
const COLONY_COLOR          = 0x7dffb0;  // green — the proposed colony shortlist (colony-engine's top 3)
const COLONY_RING_MULT      = 4.5;       // a ring, not a dot: the shortlist sits ON Artemis candidates
const MARKER_RADIUS         = 0.008;     // proportional to moon radius 1.0
// Clearance ABOVE the local ground: without a radiusAt callback the ground is
// the unit sphere, reproducing the historical fixed 1.006; with displaced
// relief (js/moon-relief.js) the marker rides the terrain.
const MARKER_CLEAR          = 0.006;
const HALO_RADIUS_MULT      = 2.6;

function _markerGeometry() {
    return new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
}

function _haloMaterial(color) {
    // Soft additive halo so the marker reads against both lunar day (bright
    // regolith) and lunar night (Earthshine-lit terminator).
    return new THREE.SpriteMaterial({
        color,
        transparent:   true,
        opacity:       0.55,
        depthWrite:    false,
        blending:      THREE.AdditiveBlending,
    });
}

function _placeMarker(group, lat, lon, color, userData = {}) {
    const dot = new THREE.Mesh(
        _markerGeometry(),
        new THREE.MeshBasicMaterial({ color }),
    );
    dot.userData = userData;
    group.add(dot);

    // Sprite halo doubles the visible footprint without bloating geometry
    const sprite = new THREE.Sprite(_haloMaterial(color));
    sprite.scale.setScalar(MARKER_RADIUS * HALO_RADIUS_MULT * 2);
    sprite.userData = userData;
    group.add(sprite);

    return { lat, lon, dot, sprite };
}

export class LandingSites {
    /**
     * @param {THREE.Object3D} parent — the MoonSkin.moonMesh (unit sphere,
     *                                    spins with lunar rotation)
     * @param {{ radiusAt?: (latDeg, lonDeg) => number }} [options]
     */
    constructor(parent, { radiusAt = null } = {}) {
        this._apollo  = new THREE.Group();
        this._artemis = new THREE.Group();
        this._colony  = new THREE.Group();
        this._apollo.name  = 'landing-sites:apollo';
        this._artemis.name = 'landing-sites:artemis3';
        this._colony.name  = 'landing-sites:colony';
        this._radiusAt = radiusAt;
        this._markers = [];

        for (const s of APOLLO_SITES) {
            this._markers.push(_placeMarker(this._apollo, s.lat, s.lon, APOLLO_COLOR, {
                site: s.id, label: s.mission, region: s.region, kind: 'apollo',
            }));
        }
        for (const s of ARTEMIS_III_CANDIDATES) {
            this._markers.push(_placeMarker(this._artemis, s.lat, s.lon, ARTEMIS_COLOR, {
                site: s.id, label: s.name, region: s.note, kind: 'artemis3',
            }));
        }
        // Colony shortlist: a wide green ring around each of the top three
        // survey sites (they coincide with Artemis candidates, so a second
        // dot would hide under the cyan one).
        this.colonySites = colonyShortlist(3);
        for (const s of this.colonySites) {
            const m = _placeMarker(this._colony, s.lat, s.lon, COLONY_COLOR, {
                site: s.colony.siteId, label: s.name, kind: 'colony', score: s.colony.score,
            });
            m.sprite.scale.setScalar(MARKER_RADIUS * COLONY_RING_MULT * 2);
            m.sprite.material.opacity = 0.75;
            m.dot.material.transparent = true;
            m.dot.material.opacity = 0.0;      // the ring carries it
            this._markers.push(m);
        }
        this._anchorAll();

        parent.add(this._apollo);
        parent.add(this._artemis);
        parent.add(this._colony);

        this._apolloVisible  = true;
        this._artemisVisible = true;
        this._colonyVisible  = true;
    }

    _anchorAll() {
        for (const marker of this._markers) {
            const p = latLonToXYZ(marker.lat, marker.lon, 1);
            const ground = this._radiusAt ? this._radiusAt(marker.lat, marker.lon) : 1;
            const r = ground + MARKER_CLEAR;
            marker.dot.position.set(p.x * r, p.y * r, p.z * r);
            marker.sprite.position.copy(marker.dot.position);
        }
    }

    /** Swap the ground function (relief applied/cleared) and re-seat markers. */
    setRadiusAt(radiusAt) {
        this._radiusAt = radiusAt || null;
        this._anchorAll();
    }

    setApolloVisible(visible)  { this._apollo.visible  = !!visible; this._apolloVisible  = !!visible; }
    setArtemisVisible(visible) { this._artemis.visible = !!visible; this._artemisVisible = !!visible; }
    setColonyVisible(visible)  { this._colony.visible  = !!visible; this._colonyVisible  = !!visible; }

    dispose() {
        for (const group of [this._apollo, this._artemis, this._colony]) {
            group.parent?.remove(group);
            group.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose?.();
                if (obj.material) obj.material.dispose?.();
            });
        }
    }
}
