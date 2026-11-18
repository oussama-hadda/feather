import * as THREE from 'three/webgpu';
import {
    Fn, Loop, If, uniform, uniformArray, float, vec2, vec3,
    sin, cos, exp, smoothstep, positionWorld, cameraPosition, transformNormalToView
} from 'three/tsl';

/**
 * Water surface with ripples.
 *
 * The surface height is an analytic function h(x, z, t) that is evaluated in two places:
 *  - in the water shader (per pixel, as a normal), so ripples stay smooth at any distance
 *  - in JavaScript, so floating feathers bob on the exact same surface
 * Both implementations below must stay in sync.
 */

export const MAX_RIPPLES = 48;

// Ripple shape: a ring of small crests that expands, widens and fades out.
const RIPPLE = {
    groupSpeed: 0.32,                 // m/s, speed of the ring envelope
    phaseSpeed: 0.21,                 // m/s, crests move slower than the ring (capillary-like)
    wavelength: 0.13,                 // m
    width0: 0.09,                     // m, ring width at birth
    widthGrowth: 0.07,                // m/s, ring widens as it travels
    damping: 0.55,                    // 1/s
    rise: 0.35,                       // s, smooth fade-in so the wave is born gently
    life: 6.5,                        // s
    spreading: 6.0                    // amplitude ~ 1 / sqrt(1 + spreading * r)
};
const K = ( Math.PI * 2 ) / RIPPLE.wavelength;

// Gentle background swell (deep water dispersion: omega = sqrt(g * k)).
function makeSwell( windAngle ) {

    const defs = [
        { k: 1.6, a: 0.010, off: 0.0 },
        { k: 2.7, a: 0.005, off: 0.6 },
        { k: 4.3, a: 0.0025, off: - 0.5 },
        { k: 7.0, a: 0.0012, off: 1.1 }
    ];

    return defs.map( ( d ) => {

        const angle = windAngle + d.off;
        return { dx: Math.cos( angle ), dz: Math.sin( angle ), k: d.k, a: d.a, w: Math.sqrt( 9.81 * d.k ) };

    } );

}

const smooth = ( e0, e1, x ) => {

    const t = Math.min( Math.max( ( x - e0 ) / ( e1 - e0 ), 0 ), 1 );
    return t * t * ( 3 - 2 * t );

};

export class Water {

    constructor( { windAngle = 0, size = 2000 } = {} ) {

        this.time = uniform( 0 );
        this.swellStrength = uniform( 1 );
        this.swell = makeSwell( windAngle );

        // x, z, birth time, amplitude
        this.ripples = Array.from( { length: MAX_RIPPLES }, () => new THREE.Vector4( 0, 0, - 1000, 0 ) );
        this.rippleUniform = uniformArray( this.ripples, 'vec4' );
        this.nextRipple = 0;

        this.mesh = new THREE.Mesh( new THREE.PlaneGeometry( size, size ).rotateX( - Math.PI / 2 ), this.createMaterial() );

    }

    createMaterial() {

        const { time, swellStrength, swell, rippleUniform } = this;

        // Returns the surface gradient (dh/dx, dh/dz) at world position p (xz).
        const gradient = Fn( ( [ p ] ) => {

            const grad = vec2( 0 ).toVar();

            for ( const s of swell ) {

                const dir = vec2( s.dx, s.dz );
                const phase = p.dot( dir ).mul( s.k ).add( time.mul( s.w ) );
                grad.addAssign( dir.mul( cos( phase ).mul( s.a * s.k ).mul( swellStrength ) ) );

            }

            Loop( MAX_RIPPLES, ( { i } ) => {

                const r = rippleUniform.element( i );
                const age = time.sub( r.z );

                If( age.greaterThan( 0 ).and( age.lessThan( RIPPLE.life ) ).and( r.w.greaterThan( 0 ) ), () => {

                    const delta = p.sub( r.xy );
                    const dist = delta.length().max( 1e-4 );
                    const width = age.mul( RIPPLE.widthGrowth ).add( RIPPLE.width0 );
                    const width2 = width.mul( width );
                    const d = dist.sub( age.mul( RIPPLE.groupSpeed ) );
                    const envelope = exp( d.mul( d ).div( width2 ).negate() );
                    const fade = exp( age.mul( - RIPPLE.damping ) )
                        .mul( smoothstep( 0, RIPPLE.rise, age ) )
                        .mul( float( 1 ).sub( smoothstep( RIPPLE.life * 0.6, RIPPLE.life, age ) ) );
                    const spread = dist.mul( RIPPLE.spreading ).add( 1 ).inverseSqrt();
                    const phase = dist.sub( age.mul( RIPPLE.phaseSpeed ) ).mul( K );
                    const dhdr = r.w.mul( fade ).mul( spread ).mul( envelope ).mul(
                        cos( phase ).mul( K ).sub( sin( phase ).mul( d ).mul( 2 ).div( width2 ) )
                    );
                    grad.addAssign( delta.div( dist ).mul( dhdr ) );

                } );

            } );

            return grad;

        } );

        const material = new THREE.MeshPhysicalNodeMaterial( {
            color: 0x0a222b,
            roughness: 0.05,
            metalness: 0,
            ior: 1.333,
            specularIntensity: 1
        } );

        material.normalNode = Fn( () => {

            // fade the detail out in the distance to avoid shimmering
            const camDist = positionWorld.sub( cameraPosition ).length();
            const g = gradient( positionWorld.xz ).mul( float( 1 ).sub( smoothstep( 15, 90, camDist ) ) );
            return transformNormalToView( vec3( g.x.negate(), 1, g.y.negate() ).normalize() );

        } )();

        return material;

    }

    addRipple( x, z, amplitude ) {

        const r = this.ripples[ this.nextRipple ];
        r.set( x, z, this.time.value, amplitude );
        this.nextRipple = ( this.nextRipple + 1 ) % MAX_RIPPLES;

    }

    /**
     * JavaScript twin of the shader: height and gradient at (x, z) for the current time.
     */
    sample( x, z, out = { h: 0, gx: 0, gz: 0 } ) {

        const t = this.time.value;
        const swellScale = this.swellStrength.value;
        let h = 0, gx = 0, gz = 0;

        for ( const s of this.swell ) {

            const phase = ( x * s.dx + z * s.dz ) * s.k + t * s.w;
            h += s.a * Math.sin( phase ) * swellScale;
            const c = s.a * s.k * Math.cos( phase ) * swellScale;
            gx += s.dx * c;
            gz += s.dz * c;

        }

        for ( const r of this.ripples ) {

            const age = t - r.z;
            if ( age <= 0 || age >= RIPPLE.life || r.w <= 0 ) continue;

            const dx = x - r.x, dz = z - r.y;
            const dist = Math.max( Math.hypot( dx, dz ), 1e-4 );
            const width = RIPPLE.width0 + age * RIPPLE.widthGrowth;
            const width2 = width * width;
            const d = dist - age * RIPPLE.groupSpeed;
            const envelope = Math.exp( - ( d * d ) / width2 );
            const fade = Math.exp( - RIPPLE.damping * age ) * smooth( 0, RIPPLE.rise, age ) * ( 1 - smooth( RIPPLE.life * 0.6, RIPPLE.life, age ) );
            const spread = 1 / Math.sqrt( 1 + RIPPLE.spreading * dist );
            const phase = ( dist - age * RIPPLE.phaseSpeed ) * K;
            const a = r.w * fade * spread * envelope;

            h += a * Math.sin( phase );
            const dhdr = a * ( K * Math.cos( phase ) - Math.sin( phase ) * 2 * d / width2 );
            gx += ( dx / dist ) * dhdr;
            gz += ( dz / dist ) * dhdr;

        }

        out.h = h;
        out.gx = gx;
        out.gz = gz;
        return out;

    }

}
