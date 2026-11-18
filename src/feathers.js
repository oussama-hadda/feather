import * as THREE from 'three/webgpu';
import {
    float, vec2, vec3, uniform, uv, sin, max, pow, mix, smoothstep, select, hash, mx_noise_float, fwidth,
    positionLocal, positionWorld, cameraPosition, instanceIndex, instancedDynamicBufferAttribute, vertexStage
} from 'three/tsl';

/**
 * Falling feathers.
 *
 * Motion model (per feather, on the CPU):
 *  - the feather's centre is carried by the wind and falls at a low terminal speed
 *    (velocity relaxes toward wind + fall speed, i.e. strong air drag)
 *  - on top of that it swings side to side like a pendulum along its width: it slides
 *    down into the middle of the swing and rises at both ends, tilting to follow the arc
 *    (the classic "falling leaf" motion)
 *  - gusts and turbulence perturb the swing, the spin and the drift
 *  - on contact with the water it emits a ripple, settles flat, floats and drifts,
 *    then slowly gets waterlogged, sinks and respawns at the top
 */

const AIR = 0, WATER = 1;

const rand = ( a, b ) => a + Math.random() * ( b - a );
const smooth = ( e0, e1, x ) => {

    const t = Math.min( Math.max( ( x - e0 ) / ( e1 - e0 ), 0 ), 1 );
    return t * t * ( 3 - 2 * t );

};

const TINTS = [ 0xffffff, 0xffffff, 0xfffdf8, 0xfaf4ea, 0xf2efea, 0xe4e1dc, 0xd9d2c8 ];

export class Feathers {

    constructor( { geometry, count, water, params, sunDirection, sunColor } ) {

        this.count = count;
        this.water = water;
        this.params = params;

        // Per-instance data for the shader: xyz = feather "up" axis, w = flutter amount.
        this.flutterAttribute = new THREE.InstancedBufferAttribute( new Float32Array( count * 4 ), 4 );
        this.flutterAttribute.setUsage( THREE.DynamicDrawUsage );

        this.time = water.time; // share the clock with the water
        this.sunDirection = uniform( sunDirection.clone().normalize() );
        this.sunColor = uniform( new THREE.Color( sunColor ) );

        this.mesh = new THREE.InstancedMesh( geometry, this.createMaterial(), count );
        this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
        this.mesh.frustumCulled = false;

        const color = new THREE.Color();
        this.feathers = [];
        for ( let i = 0; i < count; i ++ ) {

            this.mesh.setColorAt( i, color.setHex( TINTS[ Math.floor( Math.random() * TINTS.length ) ] ) );
            const f = {
                pos: new THREE.Vector3(), vel: new THREE.Vector3(), render: new THREE.Vector3(),
                quat: new THREE.Quaternion(), airQuat: new THREE.Quaternion(),
                state: AIR, landTime: 0, floatTime: 0, flutter: 1,
                phase: 0, freq: 0, swingAmp: 0, liftAmp: 0, yaw: 0, yawRate: 0,
                fallMul: 1, scale: 1, seed: Math.random() * 100
            };
            this.spawn( f, true );
            this.feathers.push( f );

        }

        // scratch objects
        this._wind = new THREE.Vector3();
        this._target = new THREE.Vector3();
        this._euler = new THREE.Euler();
        this._normal = new THREE.Vector3();
        this._align = new THREE.Quaternion();
        this._yawQuat = new THREE.Quaternion();
        this._up = new THREE.Vector3( 0, 1, 0 );
        this._yAxis = new THREE.Vector3();
        this._scale = new THREE.Vector3();
        this._matrix = new THREE.Matrix4();
        this._sample = { h: 0, gx: 0, gz: 0 };

    }

    createMaterial() {

        const time = this.time;

        // ---- vertex: flutter (shaft bending + vane edges flapping)
        const flutter = instancedDynamicBufferAttribute( this.flutterAttribute, 'vec4' );
        const along = uv().y;                           // 0 at the quill, 1 at the tip
        const across = uv().x.sub( 0.5 ).mul( 2 );      // -1 left edge, 0 shaft, +1 right edge
        const seedV = hash( instanceIndex ).mul( 100 );
        const bendShape = along.sub( 0.45 ).mul( along.sub( 0.45 ) );
        const bend = sin( time.mul( 6.5 ).add( seedV ).add( along.mul( 5 ) ) ).mul( bendShape ).mul( 0.05 );
        const flap = sin( time.mul( 9.0 ).add( seedV.mul( 1.7 ) ).add( along.mul( 7 ) ) ).mul( across.mul( across ) ).mul( 0.006 );

        const material = new THREE.MeshPhysicalNodeMaterial( {
            side: THREE.DoubleSide,
            roughness: 0.7,
            metalness: 0,
            sheen: 0.8,
            sheenRoughness: 0.45,
            sheenColor: new THREE.Color( 0xffffff ),
            alphaTest: 0.5,
            alphaToCoverage: true
        } );

        material.positionNode = positionLocal.add( flutter.xyz.mul( bend.add( flap ).mul( flutter.w ) ) );

        // ---- fragment: barbs, splits, ragged edge and fluffy down near the base
        const seed = vertexStage( hash( instanceIndex ) );
        const a = across.abs();
        const side = across.sign();
        const BARBS = 150;      // barbs along the shaft
        const SLANT = 20;       // how much barbs lean toward the tip

        const barb = along.mul( BARBS ).sub( a.mul( SLANT ) ).add( seed.mul( 13 ) );
        const thread = barb.fract().sub( 0.5 ).abs().mul( 2 );           // 0 on a barb, 1 between barbs

        // fine detail fades out when barbs get smaller than a pixel (avoids sparkly noise far away)
        const detail = float( 1 ).sub( smoothstep( 0.25, 0.7, fwidth( barb ) ) );

        const down = float( 1 ).sub( smoothstep( 0.16, 0.36, along ) );  // 1 near the quill
        const n1 = mx_noise_float( vec2( barb.mul( 0.22 ), side.mul( 7 ).add( seed.mul( 31 ) ) ) ).mul( 0.5 ).add( 0.5 );
        const n2 = mx_noise_float( vec2( barb.mul( 0.9 ), a.mul( 6 ).add( seed.mul( 17 ) ) ) ).mul( 0.5 ).add( 0.5 );

        // ragged outline, much more eroded in the downy part
        const edgeLimit = float( 1 ).sub( n1.mul( 0.16 ) ).sub( down.mul( n2 ).mul( 0.55 ) );
        const edge = edgeLimit.sub( a ).mul( 25 ).add( 0.5 );

        // splits: a few barbs separate from their neighbours, from some distance out to the edge
        const g = barb.div( 11 );
        const gid = g.floor().add( side.mul( 101 ) ).add( seed.mul( 1000 ) );
        const isSplit = hash( gid ).lessThan( 0.28 );
        const splitStart = hash( gid.add( 7 ) ).mul( 0.5 ).add( 0.3 );
        const slit = max( g.fract().sub( 0.5 ).abs().sub( 0.045 ).mul( 40 ).add( 0.5 ), splitStart.sub( a ).mul( 25 ).add( 0.5 ) );
        const split = select( isSplit, slit, float( 1 ) ).max( float( 1 ).sub( detail ) );

        // down: barbs become separate threads near the quill
        const threadWidth = mix( 1.3, 0.4, down.mul( detail ) );
        const fluff = threadWidth.sub( thread ).mul( 6 ).add( 0.5 );

        // the shaft itself is always solid
        const shaft = float( 0.035 ).sub( a ).mul( 40 ).add( 0.5 );

        material.opacityNode = max( shaft, edge.min( split ).min( fluff ) );

        const vane = mix( vec3( 1.0 ), vec3( 0.88, 0.86, 0.83 ), thread.mul( thread ).mul( 0.7 ) )
            .mul( mix( 0.93, 1.0, along ) );
        const baseColor = mix( vane, vec3( 0.97, 0.94, 0.86 ), float( 1 ).sub( smoothstep( 0.015, 0.04, a ) ) );
        material.colorNode = baseColor;

        // thin feathers glow when the low sun is behind them
        const viewDir = positionWorld.sub( cameraPosition ).normalize();
        const backlight = pow( max( viewDir.dot( this.sunDirection ), 0 ), 5 ).mul( 0.55 ).add( 0.03 );
        material.emissiveNode = baseColor.mul( this.sunColor ).mul( backlight ).mul( float( 1 ).sub( thread.mul( 0.4 ) ) );

        return material;

    }

    windAt( p, t, out ) {

        const { windStrength, windAngle, turbulence } = this.params;
        const dirX = Math.cos( windAngle * THREE.MathUtils.DEG2RAD );
        const dirZ = Math.sin( windAngle * THREE.MathUtils.DEG2RAD );

        // slow, travelling gusts
        const gust = 0.5 + 0.5 * Math.sin( t * 0.37 - ( p.x * dirX + p.z * dirZ ) * 0.18 ) * Math.sin( t * 0.21 + 1.7 + p.y * 0.2 );
        const strength = windStrength * ( 0.45 + 1.1 * gust );

        // swirling turbulence (cheap divergence-ish field made of sines)
        const tb = turbulence * ( 0.25 + 0.35 * windStrength );
        const tx = Math.sin( p.y * 1.3 + t * 0.9 + p.z * 0.7 ) + 0.5 * Math.sin( p.z * 2.1 - t * 1.7 );
        const tz = Math.cos( p.x * 1.1 - t * 0.8 + p.y * 0.6 ) + 0.5 * Math.cos( p.x * 1.9 + t * 1.4 );
        const ty = Math.sin( p.x * 0.9 + p.z * 1.2 + t * 1.1 ) * 0.5 + ( gust - 0.5 ) * 0.4;

        return out.set( dirX * strength + tx * tb, ty * tb * 0.6, dirZ * strength + tz * tb );

    }

    spawn( f, initial = false ) {

        const p = this.params;
        f.state = AIR;
        f.fallMul = rand( 0.75, 1.3 );
        f.scale = rand( 0.9, 1.5 );
        f.freq = rand( 2.4, 3.6 );
        f.phase = rand( 0, Math.PI * 2 );
        f.swingAmp = rand( 0.18, 0.4 );
        f.liftAmp = f.swingAmp * rand( 0.35, 0.55 );
        f.yaw = rand( 0, Math.PI * 2 );
        f.yawRate = rand( - 0.5, 0.5 );
        f.floatTime = rand( 7, 14 );
        f.flutter = 1;

        const height = initial ? rand( 0.4, 1 ) * p.spawnHeight : p.spawnHeight + rand( 0, 1.5 );

        // start upwind, so that the feathers land around the centre of the view
        const fallTime = height / ( p.fallSpeed * f.fallMul );
        const drift = p.windStrength * fallTime * 0.8;
        const a = p.windAngle * THREE.MathUtils.DEG2RAD;
        const r = Math.sqrt( Math.random() ) * p.area;
        const t = rand( 0, Math.PI * 2 );
        f.pos.set( Math.cos( t ) * r - Math.cos( a ) * drift, height, Math.sin( t ) * r - Math.sin( a ) * drift );
        f.vel.set( 0, - p.fallSpeed * f.fallMul, 0 );

    }

    update( dt ) {

        const t = this.time.value;
        const p = this.params;
        const s = this._sample;
        const flutterArray = this.flutterAttribute.array;

        for ( let i = 0; i < this.count; i ++ ) {

            const f = this.feathers[ i ];

            if ( f.state === AIR ) {

                // drift with the wind and fall slowly (strong drag)
                const wind = this.windAt( f.pos, t, this._wind );
                this._target.set( wind.x, wind.y - p.fallSpeed * f.fallMul, wind.z );
                f.vel.lerp( this._target, 1 - Math.exp( - 2.2 * dt ) );
                f.pos.addScaledVector( f.vel, dt );

                // pendulum swing, disturbed by gusts
                const disturb = 1 + 0.35 * p.turbulence * Math.sin( t * 1.3 + f.seed );
                f.phase += dt * f.freq * disturb;
                f.yaw += dt * ( f.yawRate + p.turbulence * 0.6 * Math.sin( t * 0.7 + f.seed * 3.1 ) );

                const swing = p.swing;
                const A = f.swingAmp * swing, C = f.liftAmp * swing;
                const sp = Math.sin( f.phase );
                const wx = Math.sin( f.yaw ), wz = Math.cos( f.yaw );      // the feather's width axis
                f.render.set( f.pos.x + wx * A * sp, f.pos.y + C * sp * sp, f.pos.z + wz * A * sp );

                // tilt to follow the swing arc (dy/dx = 2C sin(phase) / A), plus a little wobble
                const roll = A > 1e-4 ? - Math.atan( ( 2 * C / A ) * sp ) * 1.15 : 0;
                const pitch = 0.14 * Math.sin( t * 1.7 + f.seed ) + 0.08 * p.turbulence * Math.sin( t * 3.1 + f.seed * 2 );
                f.quat.setFromEuler( this._euler.set( roll, f.yaw, pitch, 'YXZ' ) );

                // flutter more when the air moves past the feather
                const airSpeed = Math.hypot( f.vel.x - wind.x, f.vel.z - wind.z ) + Math.abs( f.vel.y );
                f.flutter = 0.5 + Math.min( airSpeed, 1.5 ) * 0.5 + 0.3 * p.turbulence;

                // touch down
                this.water.sample( f.render.x, f.render.z, s );
                if ( f.render.y <= s.h + 0.004 ) {

                    const impact = Math.min( Math.abs( f.vel.y ) / 0.5, 1.5 );
                    this.water.addRipple( f.render.x, f.render.z, p.rippleStrength * 0.0045 * f.scale * ( 0.6 + 0.6 * impact ) );

                    f.state = WATER;
                    f.landTime = t;
                    f.pos.copy( f.render );
                    f.airQuat.copy( f.quat );
                    f.vel.set( f.vel.x * 0.3, 0, f.vel.z * 0.3 );

                }

            } else {

                const age = t - f.landTime;
                const wind = this.windAt( f.pos, t, this._wind );

                // drift slowly with the wind on the surface
                const k = 1 - Math.exp( - 0.8 * dt );
                f.vel.x += ( wind.x * 0.05 - f.vel.x ) * k;
                f.vel.z += ( wind.z * 0.05 - f.vel.z ) * k;
                f.pos.x += f.vel.x * dt;
                f.pos.z += f.vel.z * dt;
                f.yaw += dt * f.yawRate * 0.12;

                // float on the surface, then slowly sink once waterlogged
                this.water.sample( f.pos.x, f.pos.z, s );
                const sink = Math.max( 0, age - f.floatTime ) * 0.012;
                const settle = smooth( 0, 0.9, age );
                f.render.set( f.pos.x, s.h + 0.003 - sink, f.pos.z );

                // lie flat on the (moving) water surface
                this._normal.set( - s.gx, 1, - s.gz ).normalize();
                this._align.setFromUnitVectors( this._up, this._normal );
                this._yawQuat.setFromAxisAngle( this._up, f.yaw );
                this._align.multiply( this._yawQuat );
                f.quat.slerpQuaternions( f.airQuat, this._align, settle );

                f.flutter = THREE.MathUtils.lerp( f.flutter, 0.04, 1 - Math.exp( - 3 * dt ) );

                if ( sink > 0.06 || f.pos.lengthSq() > 40 * 40 ) this.spawn( f );

            }

            // write instance data
            this._matrix.compose( f.render, f.quat, this._scale.setScalar( f.scale ) );
            this.mesh.setMatrixAt( i, this._matrix );

            this._yAxis.set( 0, 1, 0 ).applyQuaternion( f.quat );
            flutterArray[ i * 4 ] = this._yAxis.x;
            flutterArray[ i * 4 + 1 ] = this._yAxis.y;
            flutterArray[ i * 4 + 2 ] = this._yAxis.z;
            flutterArray[ i * 4 + 3 ] = f.flutter * f.scale;

        }

        this.mesh.instanceMatrix.needsUpdate = true;
        this.flutterAttribute.needsUpdate = true;

    }

}
